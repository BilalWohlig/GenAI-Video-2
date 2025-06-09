// services/animation/animationService.js
const OpenAI = require('openai');
const { toFile } = require('openai');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');
const Animation = require('../../mongooseSchema/Animation');
const KlingAI = require('./klingAIService');

// Add required imports for audio-video sync
const { execSync, spawnSync } = require("node:child_process");
const { accessSync, unlinkSync, writeFileSync, readFileSync, constants: fsConstants } = require("node:fs");
const { access } = require("node:fs/promises");

// Helper function to execute shell commands
const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"] })
                    .toString().trim();

// Define Zod schemas for structured responses
const CharacterSchema = z.object({
  name: z.string(),
  description: z.string(),
  personality: z.string(),
  role: z.string()
});

const SceneSchema = z.object({
  sceneNumber: z.number(),
  description: z.string(),
  characters: z.array(z.string()),
  location: z.string(),
  mood: z.string(),
  cameraAngle: z.string(),
  narration: z.string(),
  duration: z.number(),
  sceneType: z.enum(['action', 'dialogue', 'landscape', 'emotional', 'standard'])
});

const StoryStructureSchema = z.object({
  title: z.string(),
  theme: z.string(),
  characters: z.array(CharacterSchema),
  scenes: z.array(SceneSchema),
  overallMood: z.string()
});

const MotionDescriptionSchema = z.object({
  motionDescription: z.string().max(150)
});

// New schema for country detection
const CountryDetectionSchema = z.object({
  primaryCountry: z.string(),
  primaryCity: z.string().nullable().optional(),
  culturalContext: z.string(),
  architecturalStyle: z.string(),
  demographicNotes: z.string(),
  languageContext: z.string()
});

class AnimationService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    this.elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    this.aivaApiKey = process.env.AIVA_API_KEY;
    this.imagekitApiKey = process.env.IMAGEKIT_API_KEY;
    this.imagekitPrivateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    this.imagekitEndpoint = process.env.IMAGEKIT_ENDPOINT;
    
    this.workingDir = path.join(__dirname, '../../temp');
    this.ensureDirectoryExists();
  }

  async ensureDirectoryExists() {
    try {
      await fs.mkdir(this.workingDir, { recursive: true });
      await fs.mkdir(path.join(this.workingDir, 'characters'), { recursive: true });
      await fs.mkdir(path.join(this.workingDir, 'scenes'), { recursive: true });
      await fs.mkdir(path.join(this.workingDir, 'videos'), { recursive: true });
      await fs.mkdir(path.join(this.workingDir, 'audio'), { recursive: true });
      await fs.mkdir(path.join(this.workingDir, 'processed'), { recursive: true });
    } catch (error) {
      console.error('Error creating directories:', error);
    }
  }

  // NEW METHOD: Detect country and cultural context from article
  async detectCountryContext(article) {
    const systemPrompt = `You are a geographical and cultural analysis expert. Analyze news articles to identify the primary country/region where events are taking place and provide relevant cultural context for animation production.`;
    
    const userPrompt = `Analyze this news article and identify the primary country where the events are taking place. Also provide cultural context that would be important for creating authentic location settings and background characters.

    Article: ${article}

    Provide:
    - Primary country where events occur
    - Primary city (if clearly mentioned)
    - Cultural context relevant for visual representation
    - Architectural style typical for that region
    - Demographic notes for background characters (ethnicity, typical clothing, etc.)
    - Language context (for signs, text in scenes)

    If multiple countries are mentioned, focus on where the main events are happening. If unclear, provide your best assessment based on context clues.`;

    try {
      const response = await this.openai.responses.parse({
        model: "gpt-4o-2024-08-06",
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        text: {
          format: zodTextFormat(CountryDetectionSchema, "countryContext")
        }
      });

      const countryContext = response.output_parsed;
      console.log(`🌍 Detected country context: ${countryContext.primaryCountry}${countryContext.primaryCity ? ` (${countryContext.primaryCity})` : ''}`);
      
      return countryContext;
    } catch (error) {
      console.error('Error detecting country context:', error);
      // Return default context if detection fails
      return {
        primaryCountry: 'International',
        primaryCity: null,
        culturalContext: 'Modern urban setting with diverse population',
        architecturalStyle: 'Contemporary international architecture',
        demographicNotes: 'Diverse, modern professional attire',
        languageContext: 'English signage and text'
      };
    }
  }

  // Helper function to trim and mux video with audio and subtitles
  async trimAndMux({ video, audio, subtitleText, out, idx, totalClips, fadeTime = 0.5 }) {
    try {
      // 1. Make sure inputs exist
      await access(video);
      await access(audio);

      // 2. Get duration of audio file (in seconds, may be fractional)
      const durOutput = sh(`ffprobe -v error -show_entries format=duration \
                       -of default=noprint_wrappers=1:nokey=1 "${audio}"`);
      const dur = parseFloat(durOutput);
      
      if (isNaN(dur)) {
        console.error(`[Debug ${idx+1}] Failed to get duration for ${audio}. ffprobe output: "${durOutput}"`);
        throw new Error(`Failed to parse duration for ${audio}`);
      }
      
      console.log(`→ Audio duration for scene ${idx+1}: ${dur}s`);

      // 3. Create SRT subtitle file
      const srtPath = path.join(this.workingDir, `subtitle${idx + 1}.srt`);
      
      const formatTime = (totalSeconds) => {
        if (isNaN(totalSeconds) || totalSeconds < 0) {
          console.warn(`[Debug ${idx+1}] Invalid totalSeconds for formatTime: ${totalSeconds}. Defaulting to 0.`);
          totalSeconds = 0;
        }
        const date = new Date(Math.round(totalSeconds * 1000));
        const timeStr = date.toISOString().slice(11, 23); 
        return timeStr.replace('.', ',');
      };

      const srtContent = `1\n00:00:00,000 --> ${formatTime(Number(dur) + 0.35)}\n${subtitleText}\n\n`;
      writeFileSync(srtPath, srtContent, "utf8");

      console.log(`[Debug ${idx+1}] Wrote SRT to: ${srtPath}`);
      
      // 4. Verify SRT file was created
      let srtFileExistsAfterWrite = false;
      try {
        accessSync(srtPath, fsConstants.F_OK);
        srtFileExistsAfterWrite = true;
      } catch (e) {
        srtFileExistsAfterWrite = false;
      }
      
      console.log(`[Debug ${idx+1}] SRT Exists? ${srtFileExistsAfterWrite}`);
      if (!srtFileExistsAfterWrite) {
        throw new Error(`CRITICAL: SRT file ${srtPath} was NOT found immediately after writing!`);
      }

      // 5. Prepare SRT path for FFmpeg filter (escape special characters)
      let srtPathForFilter = srtPath.replace(/\\/g, '/');
      srtPathForFilter = srtPathForFilter.replace(/:/g, '\\:');
      srtPathForFilter = srtPathForFilter.replace(/'/g, "'\\''");

      // 6. Calculate fade effects based on clip position
      let fadeEffects = "";
      let audioFadeEffects = "";
      const isFirstClip = idx === 0;
      const isLastClip = idx === totalClips - 1;
      
      if (isFirstClip && isLastClip) {
        // Single clip - fade in and out
        fadeEffects = `,fade=t=in:st=0:d=${fadeTime},fade=t=out:st=${dur - fadeTime}:d=${fadeTime}`;
        audioFadeEffects = `afade=t=in:st=0:d=${fadeTime},afade=t=out:st=${dur - fadeTime}:d=${fadeTime}`;
      } else if (isFirstClip) {
        // First clip - only fade in
        fadeEffects = `,fade=t=in:st=0:d=${fadeTime}`;
        audioFadeEffects = `afade=t=in:st=0:d=${fadeTime}`;
      } else if (isLastClip) {
        // Last clip - only fade out
        fadeEffects = `,fade=t=out:st=${dur - fadeTime}:d=${fadeTime}`;
        audioFadeEffects = `afade=t=out:st=${dur - fadeTime}:d=${fadeTime}`;
      }
      
      // 7. Build FFmpeg command arguments
      const ffArgs = [
        "-ss", "0", "-t", (Number(dur) + 0.3).toString(), "-i", video,
        "-i", audio,
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-crf", "20", "-preset", "fast",
        "-c:a", "aac", "-ac", "2",
        "-vf", `fps=30,scale=1920:1080,format=yuv420p,subtitles='${srtPathForFilter}':force_style='FontName=Arial,FontSize=16,PrimaryColour=&Hffffff,OutlineColour=&H000000,BorderStyle=1,Outline=1,Shadow=0,MarginV=30'${fadeEffects}`,
        ...(audioFadeEffects ? ["-af", audioFadeEffects] : []),
        "-shortest", out
      ];

      console.log(`[Debug ${idx+1}] Running ffmpeg with args: ffmpeg ${ffArgs.join(' ')}`);

      // 8. Execute FFmpeg command
      const { status, error } = spawnSync("ffmpeg", ffArgs, { stdio: "inherit" });
      
      if (status !== 0) {
        console.error(`[Debug ${idx+1}] ffmpeg failed for ${video}. Status: ${status}`, error);
        throw new Error(`ffmpeg failed on ${video}. Status: ${status}`);
      }

      // 9. Cleanup SRT file
      let srtFileExistsBeforeUnlink = false;
      try {
        accessSync(srtPath, fsConstants.F_OK);
        srtFileExistsBeforeUnlink = true;
      } catch (e) {
        srtFileExistsBeforeUnlink = false;
      }
      
      if (srtFileExistsBeforeUnlink) {
        unlinkSync(srtPath); 
      }

      console.log(`✅ Scene ${idx+1} processed successfully - Duration: ${dur}s`);
      return dur;

    } catch (error) {
      console.error(`❌ Error processing scene ${idx+1}:`, error);
      throw error;
    }
  }

  // UPDATED: Phase 1: Story Development with Country Context
  async generateStoryStructure(article, sceneCount) {
    // First, detect the country context
    const countryContext = await this.detectCountryContext(article);

    const systemPrompt = `You are a professional news animator who creates Disney/Pixar-style 3D animated news stories. Your job is to transform real news articles into visually appealing animated content while maintaining journalistic accuracy and realism. Use Disney/Pixar's high-quality 3D animation style but keep the content factual, realistic, and true to the news story.

    CRITICAL: When real public figures are mentioned in the article (politicians, celebrities, business leaders, etc.), you MUST include their actual names in the character descriptions. This helps create recognizable Disney/Pixar styled versions of real people.

    COUNTRY & CULTURAL CONTEXT: This story takes place primarily in ${countryContext.primaryCountry}${countryContext.primaryCity ? ` (${countryContext.primaryCity})` : ''}. Ensure all locations, general public characters, and cultural elements are authentic to this region.`;
    
    const userPrompt = `Transform this news article into a realistic Disney/Pixar-style 3D animated news story with exactly ${sceneCount} scenes.

    Article: ${article}

    COUNTRY-SPECIFIC REQUIREMENTS:
    🌍 PRIMARY LOCATION: ${countryContext.primaryCountry}${countryContext.primaryCity ? ` (${countryContext.primaryCity})` : ''}
    🏛️ ARCHITECTURAL STYLE: ${countryContext.architecturalStyle}
    👥 DEMOGRAPHIC CONTEXT: ${countryContext.demographicNotes}
    🗣️ LANGUAGE CONTEXT: ${countryContext.languageContext}
    🎭 CULTURAL CONTEXT: ${countryContext.culturalContext}

    IMPORTANT GUIDELINES:
    - Keep the story FACTUAL and REALISTIC - no magic, fantasy, or fictional elements
    - Use Disney/Pixar 3D animation VISUAL STYLE only (high-quality 3D rendering, appealing character designs, vibrant colors)
    - Characters should be realistic people/professionals, not magical beings
    - Settings should be real-world locations specific to ${countryContext.primaryCountry}
    - Focus on the actual events, people, and facts from the news
    - Make it informative and engaging but grounded in reality
    - Characters should look professional and appropriate for the news context
    - Characters should not have any artifact in their hands.
    - Avoid any Disney-like magical transformations, talking animals, or fantastical elements

    COUNTRY-SPECIFIC CHARACTER & LOCATION GUIDELINES:
    🏢 LOCATIONS: Use authentic ${countryContext.primaryCountry} settings:
    - Government buildings should reflect ${countryContext.primaryCountry}'s architectural style
    - Street scenes should show typical ${countryContext.primaryCountry} urban/suburban environments
    - Office buildings, schools, hospitals should match local architectural standards
    - Include appropriate signage and text in ${countryContext.languageContext}
    - Backgrounds should reflect ${countryContext.culturalContext}

    👥 GENERAL PUBLIC CHARACTERS (non-famous people): 
    - Reflect authentic ${countryContext.primaryCountry} demographics: ${countryContext.demographicNotes}
    - Clothing should be appropriate for ${countryContext.primaryCountry} professional/casual standards
    - Facial features and appearances should be representative of ${countryContext.primaryCountry} population
    - Names for unnamed characters should be culturally appropriate for ${countryContext.primaryCountry}
    - Professional attire should match ${countryContext.primaryCountry} business culture

    CHARACTER NAMING GUIDELINES:
    **CRITICAL**: If the article mentions real public figures by name, you MUST include their actual names in character descriptions. This includes:
    - Politicians (presidents, ministers, senators, mayors, etc.)
    - Business Leaders (CEOs, entrepreneurs, executives)
    - Celebrities (actors, musicians, entertainers)
    - Sports Personalities (athletes, coaches, team owners)
    - Social Media Influencers / Content Creators
    - Journalists and Media Personalities
    - Religious or Spiritual Leaders
    - Academics and Intellectuals (professors, researchers, scientists)
    - Public Interest Litigants and Activists
    - Models and Fashion Icons
    - Any other recognizable public figures

    For general public/unnamed characters (citizens, officials, workers), use culturally appropriate names for ${countryContext.primaryCountry} and ensure their appearance reflects local demographics.

    **CHARACTER APPEARANCE GUIDELINES - VERY IMPORTANT**:
    - Characters must be described WITHOUT any objects, artifacts, or items in their hands
    - NO microphones, phones, documents, papers, tools, or any handheld items
    - Characters should have EMPTY HANDS or hands at their sides
    - Focus only on their physical appearance, clothing, and facial features
    - This ensures clean character references that work across all scenes
    
    **AVOID in character descriptions**:
    ❌ "holding a microphone"
    ❌ "with a phone in hand"
    ❌ "carrying documents"
    ❌ "holding a clipboard"
    ❌ "with a pen"
    ❌ "gripping a tool"
    
    **GOOD character descriptions**:
    ✅ "professional business attire appropriate for ${countryContext.primaryCountry}, confident posture, hands at sides"
    ✅ "formal suit matching ${countryContext.primaryCountry} government official style, authoritative presence, empty hands"
    ✅ "casual professional clothing typical of ${countryContext.primaryCountry}, friendly expression, relaxed stance"

    For example:
    - If article mentions "Elon Musk", character description should be: "Elon Musk - Tech entrepreneur and CEO, rendered in Disney/Pixar 3D style with professional business attire, confident demeanor, hands at sides, no objects or artifacts"
    - For general public: "Local ${countryContext.primaryCountry} Citizen - Middle-aged person with appearance typical of ${countryContext.primaryCountry} demographics, wearing ${countryContext.demographicNotes}, friendly expression, hands free of any objects"

    Create:
    - Realistic character descriptions with ACTUAL NAMES when public figures are mentioned
    - General public characters that authentically represent ${countryContext.primaryCountry} demographics
    - Character descriptions should include their real-world role/profession
    - Disney/Pixar 3D styled versions of real people when applicable
    - **Characters MUST have empty hands and no artifacts/objects**
    - Factual scene descriptions based on actual events in the article
    - Locations that are authentic to ${countryContext.primaryCountry}
    - Professional, news-appropriate narration
    - Scene types optimized for subtle, realistic movements
    - Each scene should be 10 seconds duration for clarity, but for narration text, it should be as if each respective clip is 6-8s long`;

    try {
      const response = await this.openai.responses.parse({
        model: "gpt-4o-2024-08-06",
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        text: {
          format: zodTextFormat(StoryStructureSchema, "story")
        }
      });

      const storyData = response.output_parsed;
      
      // Add country context to story data
      storyData.countryContext = countryContext;
      
      for(const character of storyData.characters) {
        if (character.name && character.description) {
          character.description = `${character.name} - ${character.description}`;
        }
      }
      
      console.log("StoryData", storyData.characters);
      console.log("StoryData", storyData.scenes);
      
      console.log(`✅ Country-aware news story generated: "${storyData.title}" with ${storyData.characters.length} characters`);
      console.log(`🌍 Tailored for: ${countryContext.primaryCountry}${countryContext.primaryCity ? ` (${countryContext.primaryCity})` : ''}`);
      
      return storyData;
    } catch (error) {
      console.error('Error generating story structure:', error);
      throw new Error('Failed to generate story structure');
    }
  }

  // UPDATED: Phase 2: Character Generation with Country Context
  async generateCharacterAssets(characters, countryContext) {
    const characterAssets = {};

    for (const character of characters) {
      try {
        console.log(`🎭 Generating country-appropriate character: ${character.name}`);

        // Generate master character image with country context
        const masterCharacterPrompt = `
        Create a Disney/Pixar style 3D character: ${character.description}. 
        ${character.personality}. 
        
        COUNTRY CONTEXT: This character is in ${countryContext.primaryCountry}. Ensure authenticity:
        - Appearance should reflect ${countryContext.demographicNotes}
        - Clothing style appropriate for ${countryContext.primaryCountry} professional/cultural standards
        - Facial features representative of ${countryContext.primaryCountry} population (if applicable)
        - Cultural authenticity in overall presentation
        
        CRITICAL REQUIREMENTS:
        - Front view, neutral expression, clean white background
        - High quality 3D rendering, professional Disney/Pixar animation style
        - Vibrant colors, appealing character design
        - HANDS MUST BE EMPTY - no objects, artifacts, or items in hands
        - Hands should be at sides or in relaxed position
        - NO microphones, phones, documents, tools, or any handheld items
        - Focus on facial features, clothing, and overall appearance only
        - Clean, uncluttered character reference suitable for all scenes
        - Authentic to ${countryContext.primaryCountry} cultural context`;

        const masterImagePath = await this.generateImage(masterCharacterPrompt);
        
        // Generate character expressions using master image as reference
        const expressions = [];
        const characterExpressions = {};
        
        for (const expression of expressions) {
            const expressionPrompt = `
            Change the character's expression to ${expression} while maintaining the exact same character design, 
            style, colors, and physical appearance. Same Disney/Pixar 3D animation style, 
            front view, white background. Keep all character features identical except the facial expression.
            Maintain cultural authenticity for ${countryContext.primaryCountry}.
            
            CRITICAL: Keep hands EMPTY and free of any objects, artifacts, or items - exactly like the reference image.
            Maintain the same hand positioning and ensure no objects appear in the hands.`;  
          
          const expressionImagePath = await this.generateImageWithReference(
            [masterImagePath], 
            expressionPrompt
          );
          characterExpressions[expression] = expressionImagePath;
        }

        characterAssets[character.name] = {
          master: masterImagePath,
          expressions: characterExpressions,
          description: character.description,
          countryContext: countryContext
        };

        // Copy to permanent character directory
        const permanentPath = path.join(this.workingDir, 'characters', `${character.name}_master.png`);
        await fs.copyFile(masterImagePath, permanentPath);
        
        console.log(`✅ Generated ${countryContext.primaryCountry}-appropriate character ${character.name} with ${expressions.length} expressions`);
        
      } catch (error) {
        console.error(`Error generating character ${character.name}:`, error);
        throw new Error(`Failed to generate character: ${character.name}`);
      }
    }

    return characterAssets;
  }

  // UPDATED: Phase 3: Scene Generation with Country Context, Minimal Text, and Detailed Descriptions
  async generateSceneImages(scenes, characterAssets, countryContext) {
    const sceneImages = [];

    for (const scene of scenes) {
      try {
        console.log(`🎬 Generating ${countryContext.primaryCountry}-authentic scene ${scene.sceneNumber}: ${scene.description.substring(0, 50)}...`);

        // Apply content safety filter
        const { sanitizedDescription, wasModified } = this.sanitizeSceneForContentPolicy(scene.description, scene.sceneType);

        // Collect reference images for characters in this scene
        const referenceImages = [];
        let enhancedPrompt = sanitizedDescription;

        // Build detailed character positioning and actions
        let characterDetails = "";
        if (scene.characters && scene.characters.length > 0) {
          // Build character reference mapping
          let characterReferences = [];
          
          scene.characters.forEach((charName, index) => {
            if (characterAssets[charName] && characterAssets[charName].master) {
              referenceImages.push(characterAssets[charName].master);
              characterReferences.push(`${charName}(image ${index + 1})`);
              
              // Add detailed character positioning based on scene type
              characterDetails += this.generateDetailedCharacterDescription(charName, index + 1, scene, countryContext);
            }
          });

          // Update prompt to reference character images
          if (characterReferences.length > 0) {
            // Replace character names in description with image references
            let updatedDescription = enhancedPrompt;
            scene.characters.forEach((charName, index) => {
              if (characterAssets[charName]) {
                const regex = new RegExp(`\\b${charName}\\b`, 'gi');
                updatedDescription = updatedDescription.replace(regex, `${charName}(image ${index + 1})`);
              }
            });
            
            enhancedPrompt = updatedDescription;
          }
        }

        // Generate detailed environmental description
        const environmentalDetails = this.generateDetailedEnvironmentalDescription(scene, countryContext);
        
        // Generate detailed lighting and mood specifications
        const lightingDetails = this.generateDetailedLightingDescription(scene, countryContext);
        
        // Generate detailed composition and camera specifications
        const compositionDetails = this.generateDetailedCompositionDescription(scene, countryContext);

        // Build complete realistic scene prompt with extremely detailed descriptions
        let fullScenePrompt = `
        HIGHLY DETAILED Disney/Pixar 3D animation scene: ${enhancedPrompt}
        
        SCENE LOCATION SPECIFICATIONS:
        Primary Location: ${scene.location}
        Scene Mood: ${scene.mood}
        Camera Position: ${scene.cameraAngle}
        
        DETAILED CHARACTER POSITIONING & ACTIONS:
        ${characterDetails}
        
        DETAILED ENVIRONMENTAL DESCRIPTION:
        ${environmentalDetails}
        
        DETAILED LIGHTING & ATMOSPHERE:
        ${lightingDetails}
        
        DETAILED COMPOSITION & FRAMING:
        ${compositionDetails}
        
        COUNTRY-SPECIFIC AUTHENTICITY FOR ${countryContext.primaryCountry}:
        🏛️ Architecture: ${countryContext.architecturalStyle}
        🌍 Cultural Setting: ${countryContext.culturalContext}
        🗣️ Signage/Text: ${countryContext.languageContext}
        👥 Background People: ${countryContext.demographicNotes}
        
        TEXT CONTENT RESTRICTIONS - CRITICAL:
        📝 MINIMIZE ALL TEXTUAL CONTENT in the scene:
        
        ✅ ALLOWED TEXT (keep minimal and blurred):
        - Basic building names (office buildings, hospitals, schools)
        - Essential traffic signs (STOP, street names)
        - Basic directional signs (EXIT, ENTRANCE)
        - Generic storefront names (PHARMACY, CAFE, BANK)
        
        ❌ AVOID COMPLETELY:
        - News headlines or ticker text
        - Newspaper text or readable content
        - Advertising banners or promotional signs
        - Protest signs or placards with text
        - TV screens with text content
        - Social media interfaces or screens
        - Detailed poster text or flyers
        - Magazine covers with text
        - Digital displays with news content
        - Billboard advertisements with text
        - Street banners with promotional messages
        - Any readable text that could distract from the scene
        
        🎯 TEXT RENDERING GUIDELINES:
        - Keep all text very small, blurred, or out of focus
        - Use generic, non-readable text styling
        - Focus on shapes and colors rather than readable content
        - Make any background text appear as visual texture, not readable information
        - Prioritize clean, uncluttered visual composition
        - Text should blend into the background as environmental detail
        
        TECHNICAL RENDERING SPECIFICATIONS:
        - Ultra-high quality Disney/Pixar 3D rendering
        - Professional cinematic lighting with realistic shadows and reflections
        - Photorealistic materials and textures
        - Advanced depth of field and bokeh effects
        - Vibrant but naturalistic color grading
        - Sharp focus on main subjects with appropriate background blur
        - Film-quality composition and framing
        - Professional broadcast-ready visual quality
        
        CULTURAL AUTHENTICITY REQUIREMENTS:
        - Buildings and infrastructure must match ${countryContext.architecturalStyle}
        - Street scenes include typical ${countryContext.primaryCountry} elements (vehicles, street furniture, signage styles)
        - Background characters reflect authentic local demographics: ${countryContext.demographicNotes}
        - Environmental details culturally accurate for ${countryContext.primaryCountry}
        - Weather and lighting appropriate for the geographical region
        - Local architectural details and urban planning styles
        - Authentic vehicle models and license plate styles for the region
        - Appropriate flora and landscape elements for the climate
        
        CONTENT SAFETY & PROFESSIONALISM:
        - Maintain REALISTIC and NEWS-APPROPRIATE content
        - Focus on aftermath, response, and community impact rather than violent actions
        - Show professional emergency responders, investigators, and community support
        - Avoid graphic content, violence, or disturbing imagery
        - Family-friendly presentation suitable for broadcast news
        - No weapons, blood, or explicit violence - emphasize response and recovery
        - Highlight human resilience, community support, and professional response
        - Clean visual environment without distracting textual elements
        
        CHARACTER CONSISTENCY REQUIREMENTS:
        - Maintain exact character designs, colors, and physical features from reference images
        - Keep consistent facial features, hair, clothing, and body proportions
        - Ensure professional, realistic appearance appropriate for ${countryContext.primaryCountry} context
        - Characters should maintain their established visual identity across all scenes
        - Preserve character personality through body language and positioning
        
        FINAL QUALITY STANDARDS:
        - No magical elements, fantasy creatures, or fictional aspects
        - Professional, real-world setting appropriate for news content
        - Modern, contemporary ${countryContext.primaryCountry} environments
        - Maintain journalistic accuracy and cultural authenticity
        - Minimize readable text to maintain focus on visual narrative
        - Achieve broadcast-quality, professional animation standards`;

        let sceneImagePath;

        if (referenceImages.length > 0) {
          // Generate scene with character references and detailed descriptions
          console.log(`   Using ${referenceImages.length} character reference images with detailed scene specifications for ${countryContext.primaryCountry}-authentic scene`);
          sceneImagePath = await this.generateImageWithReference(referenceImages, fullScenePrompt);
        } else {
          // Generate scene without character references but with detailed descriptions
          console.log(`   Generating detailed scene without character references for ${countryContext.primaryCountry}-authentic environment`);
          sceneImagePath = await this.generateImage(fullScenePrompt);
        }
        
        sceneImages.push({
          sceneNumber: scene.sceneNumber,
          image: sceneImagePath,
          description: scene.description,
          sanitizedDescription: sanitizedDescription,
          narration: scene.narration,
          duration: scene.duration || 5,
          sceneType: scene.sceneType || 'standard',
          charactersUsed: scene.characters || [],
          contentModified: wasModified,
          countryContext: countryContext,
          detailedPromptUsed: true // Flag to indicate detailed prompting was used
        });

        // Copy to permanent scene directory
        const permanentPath = path.join(this.workingDir, 'scenes', `scene_${scene.sceneNumber}.png`);
        await fs.copyFile(sceneImagePath, permanentPath);

        if (wasModified) {
          console.log(`✅ Content-safe ${countryContext.primaryCountry}-authentic detailed scene ${scene.sceneNumber} generated with minimal text (content modified for safety)`);
        } else {
          console.log(`✅ ${countryContext.primaryCountry}-authentic detailed scene ${scene.sceneNumber} generated with minimal text and ${scene.characters?.length || 0} character references`);
        }

      } catch (error) {
        console.error(`Error generating detailed scene ${scene.sceneNumber}:`, error);
        throw new Error(`Failed to generate detailed scene: ${scene.sceneNumber}`);
      }
    }

    return sceneImages;
  }

  // Helper method to generate detailed family-friendly character descriptions
  generateDetailedCharacterDescription(charName, imageIndex, scene, countryContext) {
    const sceneTypePositioning = {
      'action': {
        primary: 'positioned dynamically in the center-left of frame, body slightly turned towards camera, confident coordination stance with feet shoulder-width apart',
        secondary: 'positioned in background right, observing the coordination activities, hands at sides, professional supportive posture'
      },
      'dialogue': {
        primary: 'positioned center frame, facing slightly left, direct eye contact towards camera, engaged positive expression, hands relaxed at sides',
        secondary: 'positioned right side of frame, angled towards primary character, attentive listening posture, respectful collaborative distance'
      },
      'landscape': {
        primary: 'positioned in lower third of frame, establishing human scale against architecture, looking towards positive coordination activities',
        secondary: 'positioned further back, integrated into environmental context, contributing to positive scene composition'
      },
      'emotional': {
        primary: 'positioned center frame, close-up composition, expressive face clearly visible, positive emotion conveyed through professional posture',
        secondary: 'positioned in soft focus background, supportive presence, complementary positive body language'
      },
      'standard': {
        primary: 'positioned center-right of frame, professional coordination stance, clear visibility of face and upper body, appropriate for positive community context',
        secondary: 'positioned to left side, balanced composition, maintaining positive professional appearance'
      }
    };

    const positioning = sceneTypePositioning[scene.sceneType] || sceneTypePositioning['standard'];
    const isPrimary = imageIndex === 1;
    const charPosition = isPrimary ? positioning.primary : positioning.secondary;

    // Sanitize mood for family-friendly content
    const safeMood = scene.mood
      .replace(/serious|urgent|concerned/gi, 'focused')
      .replace(/crisis|emergency/gi, 'coordination')
      .replace(/investigation/gi, 'planning');

    return `
    CHARACTER ${imageIndex} - ${charName}(image ${imageIndex}):
    - POSITIONING: ${charPosition}
    - CULTURAL CONTEXT: Appearance and attire authentic to ${countryContext.primaryCountry} positive professional standards
    - CLOTHING: Appropriate for ${countryContext.primaryCountry} ${safeMood} coordination setting, matching local professional dress codes
    - EXPRESSION: ${safeMood} expression appropriate for positive community context, conveying ${scene.sceneType} coordination emotion
    - BODY LANGUAGE: Professional, positive coordination posture with hands clearly visible and empty of objects
    - ACTIVITY: Engaged in constructive coordination and positive professional activities
    - LIGHTING: Character lit with warm professional lighting, clear positive facial features, no harsh shadows
    - DEPTH: ${isPrimary ? 'Primary focus with sharp positive detail' : 'Secondary depth with positive background integration'}
    - CULTURAL DETAILS: Authentic ${countryContext.primaryCountry} demographic representation in facial features and positive styling
    - INTERACTION: All interactions appear constructive, supportive, and professionally collaborative
    `;
  }

  // Helper method to generate detailed family-friendly environmental descriptions
  generateDetailedEnvironmentalDescription(scene, countryContext) {
    const locationTypes = {
      'office': `Modern ${countryContext.primaryCountry} office environment with welcoming local architectural details, contemporary furniture matching regional business culture, pleasant lighting fixtures, clean organized design reflecting local corporate aesthetics, appropriate window views of ${countryContext.primaryCountry} positive cityscape with coordination activities`,
      
      'street': `Pleasant ${countryContext.primaryCountry} street scene with beautiful local architecture: ${countryContext.architecturalStyle}, well-maintained vehicles with regional characteristics, attractive street furniture matching local municipal standards, pedestrian infrastructure typical of ${countryContext.primaryCountry} positive urban planning, pleasant weather conditions for the region`,
      
      'government': `Professional ${countryContext.primaryCountry} government building interior/exterior featuring impressive national architectural style, formal institutional design elements, appropriate national symbols and architectural details, positive civic environment matching local government building standards with coordination activities`,
      
      'residential': `Pleasant ${countryContext.primaryCountry} residential area with beautiful local housing architecture, regional landscape elements, appropriate attractive flora for the climate, neighborhood characteristics matching local suburban/urban development patterns with positive community coordination`,
      
      'hospital': `Professional ${countryContext.primaryCountry} medical facility with modern welcoming healthcare environment, clean positive clinical design, appropriate medical equipment visible but not prominent, professional healthcare setting matching local medical infrastructure standards with coordination activities`,
      
      'school': `Educational facility in ${countryContext.primaryCountry} with impressive local school architecture, positive educational environment appropriate for the region, modern learning facilities matching local educational infrastructure standards with coordination activities`
    };

    // Determine location type from scene location
    let locationType = 'office'; // default
    const location = scene.location.toLowerCase();
    if (location.includes('street') || location.includes('road') || location.includes('plaza')) locationType = 'street';
    else if (location.includes('government') || location.includes('capitol') || location.includes('ministry')) locationType = 'government';
    else if (location.includes('home') || location.includes('house') || location.includes('residential')) locationType = 'residential';
    else if (location.includes('hospital') || location.includes('medical') || location.includes('clinic')) locationType = 'hospital';
    else if (location.includes('school') || location.includes('university') || location.includes('campus')) locationType = 'school';

    const baseEnvironment = locationTypes[locationType] || locationTypes['office'];

    return `
    FAMILY-FRIENDLY ENVIRONMENTAL SPECIFICATIONS:
    - PRIMARY SETTING: ${baseEnvironment}
    - ARCHITECTURAL DETAILS: Beautiful ${countryContext.architecturalStyle} with attractive construction materials and positive design elements
    - BACKGROUND ELEMENTS: 3-5 carefully placed positive environmental props that enhance the coordination scene without clutter (attractive furniture, coordination equipment, pleasant architectural features)
    - SCALE & PROPORTION: Realistic human scale relative to welcoming environment, proper perspective and positive depth
    - CULTURAL AUTHENTICITY: All environmental elements reflect positive ${countryContext.primaryCountry} design standards and cultural preferences
    - CLEANLINESS: Professional, well-maintained, welcoming environment appropriate for positive community coordination
    - DEPTH LAYERS: Foreground (2-3 positive elements), middle ground (main coordination area), background (supporting positive environmental context)
    - MATERIAL QUALITY: Attractive realistic textures and materials - glass, metal, wood, concrete, fabric - all rendered with appealing photorealistic quality
    - ATMOSPHERIC PERSPECTIVE: Positive depth cues with background elements appearing pleasant and inviting
    - REGIONAL FLORA: If outdoor scene, include beautiful appropriate vegetation and landscape elements for ${countryContext.primaryCountry} climate
    - ACTIVITY CONTEXT: All environmental elements suggest positive coordination, planning, and community collaboration activities
    `;
  }

  // Helper method to generate detailed family-friendly lighting descriptions
  generateDetailedLightingDescription(scene, countryContext) {
    const moodLighting = {
      'serious': 'Professional warm lighting with balanced contrast, maintaining clear positive visibility while conveying focus through welcoming directional lighting',
      'urgent': 'Balanced contrast with pleasant color temperature, professional coordination lighting that conveys productivity without being dramatic, clean and clear positive illumination',
      'hopeful': 'Warm, balanced lighting with soft shadows, optimistic color temperature leaning warm, professional quality with uplifting atmospheric feel',
      'concerned': 'Warm professional lighting with controlled contrast, maintaining positive standards while conveying focus through pleasant lighting direction',
      'informative': 'Clean, pleasant coordination lighting optimized for clarity and positive information delivery, minimal shadows, crisp and welcoming illumination',
      'professional': 'Standard welcoming lighting setup with proper key, fill, and background lighting, pleasant color temperature and positive contrast ratios',
      'focused': 'Concentrated warm lighting emphasizing positive coordination activities with pleasant atmospheric quality'
    };

    const timeOfDay = this.determineTimeOfDay(scene);
    const weatherConditions = this.determineWeatherConditions(scene, countryContext);

    // Sanitize mood for family-friendly lighting
    const safeMood = scene.mood
      .replace(/serious|urgent|concerned/gi, 'focused')
      .replace(/crisis|emergency/gi, 'coordination')
      .replace(/investigation/gi, 'planning');

    return `
    POSITIVE LIGHTING & ATMOSPHERE SPECIFICATIONS:
    - PRIMARY LIGHTING: ${moodLighting[safeMood] || moodLighting['professional']}
    - TIME OF DAY: ${timeOfDay.description} with appropriate pleasant natural lighting conditions
    - WEATHER: ${weatherConditions.description} affecting ambient lighting and positive atmosphere
    - COLOR TEMPERATURE: ${timeOfDay.colorTemp} maintaining pleasant natural appearance for ${countryContext.primaryCountry} geographical location
    - SHADOW QUALITY: Soft, appealing shadows with proper depth and direction, avoiding harsh or distracting shadow patterns
    - AMBIENT OCCLUSION: Subtle environmental shadowing that enhances depth and positive realism without darkening the scene
    - REFLECTION QUALITY: Appropriate pleasant reflections on glass, metal, and polished surfaces maintaining welcoming photorealistic quality
    - ATMOSPHERIC EFFECTS: ${weatherConditions.atmospherics} contributing to positive environmental authenticity
    - CONTRAST RATIO: Pleasant standards maintaining detail in both highlights and shadows with positive energy
    - HIGHLIGHT MANAGEMENT: Controlled highlights preventing overexposure while maintaining attractive material authenticity
    - BACKGROUND LIGHTING: Graduated pleasant lighting that supports positive depth perception and welcoming environmental integration
    - REGIONAL LIGHTING: Appropriate for ${countryContext.primaryCountry} geographical latitude and typical pleasant weather patterns
    - MOOD ENHANCEMENT: Lighting specifically designed to create positive, welcoming, and constructive atmosphere for coordination activities
    `;
  }

  // Helper method to generate detailed family-friendly composition descriptions
  generateDetailedCompositionDescription(scene, countryContext) {
    const cameraAngles = {
      'close-up': 'Welcoming framing focusing on positive character expressions and emotions, pleasant depth of field highlighting subjects in positive environment',
      'medium shot': 'Balanced composition showing characters from waist up, optimal for positive dialogue and character coordination interaction',
      'wide shot': 'Pleasant establishing composition showing full environment and positive character context, appropriate for location and coordination establishment',
      'over-the-shoulder': 'Dynamic composition providing viewer perspective and positive character connection, professional coordination-style framing',
      'low angle': 'Slight upward angle conveying positive authority and importance, maintaining professional community coordination standards',
      'high angle': 'Elevated perspective providing comprehensive positive view while maintaining subject dignity and professional presentation',
      'eye level': 'Standard professional coordination framing at natural eye level, optimal for viewer connection and positive information delivery'
    };

    const angle = scene.cameraAngle.toLowerCase();
    let cameraSpec = cameraAngles['eye level']; // default
    
    Object.keys(cameraAngles).forEach(key => {
      if (angle.includes(key.replace('-', ' ')) || angle.includes(key.replace(' ', ''))) {
        cameraSpec = cameraAngles[key];
      }
    });

    return `
    POSITIVE COMPOSITION & FRAMING SPECIFICATIONS:
    - CAMERA ANGLE: ${cameraSpec}
    - ASPECT RATIO: 16:9 professional format optimized for positive community coordination presentation
    - RULE OF THIRDS: Strategic placement of key elements along compositional grid lines for welcoming visual balance
    - DEPTH OF FIELD: Appropriate focus zones - sharp foreground subjects with controlled pleasant background focus based on coordination scene requirements
    - LEADING LINES: Environmental elements that guide viewer attention to primary coordination subjects without distraction
    - VISUAL BALANCE: Harmonious distribution of positive visual weight across the frame, avoiding cluttered or unbalanced compositions
    - HEADROOM: Appropriate pleasant space above characters maintaining professional welcoming framing standards
    - BREATHING ROOM: Adequate space around subjects preventing cramped or claustrophobic framing, promoting positive energy
    - BACKGROUND INTEGRATION: Background elements support and positively complement primary coordination subjects
    - CULTURAL FRAMING: Composition style appropriate for ${countryContext.primaryCountry} positive community coordination standards
    - MOVEMENT SPACE: If applicable, appropriate directional space for positive implied movement or coordination eye lines
    - SYMMETRY/ASYMMETRY: Balanced compositional approach appropriate for positive community content and coordination scene type
    - FRAME STABILITY: Solid, stable composition suitable for professional coordination without distracting tilt or unusual angles
    - VISUAL HIERARCHY: Clear primary, secondary, and tertiary elements guiding viewer attention through the positive coordination scene effectively
    - POSITIVE ENERGY: Composition specifically designed to convey collaboration, teamwork, and constructive community activities
    `;
  }

  // Helper method to determine time of day from scene context
  determineTimeOfDay(scene) {
    const description = scene.description.toLowerCase();
    
    if (description.includes('morning') || description.includes('dawn') || description.includes('sunrise')) {
      return {
        description: 'Morning (8:00-11:00 AM)',
        colorTemp: '5600K natural daylight with warm morning undertones'
      };
    } else if (description.includes('afternoon') || description.includes('noon') || description.includes('midday')) {
      return {
        description: 'Midday (11:00 AM-2:00 PM)',
        colorTemp: '6500K bright daylight with neutral color balance'
      };
    } else if (description.includes('evening') || description.includes('sunset') || description.includes('dusk')) {
      return {
        description: 'Evening (5:00-7:00 PM)',
        colorTemp: '3200K warm evening light with golden undertones'
      };
    } else if (description.includes('night') || description.includes('nighttime')) {
      return {
        description: 'Evening/Night (7:00-9:00 PM)',
        colorTemp: '3000K warm artificial lighting with cool ambient shadows'
      };
    } else {
      return {
        description: 'Professional indoor lighting (business hours)',
        colorTemp: '4000K balanced artificial lighting with natural undertones'
      };
    }
  }

  // Helper method to determine weather conditions
  determineWeatherConditions(scene, countryContext) {
    const description = scene.description.toLowerCase();
    const mood = scene.mood.toLowerCase();
    
    if (description.includes('rain') || description.includes('storm') || mood.includes('gloomy')) {
      return {
        description: 'Overcast with light atmospheric haze',
        atmospherics: 'Soft, diffused lighting with increased atmospheric perspective and subtle moisture in air'
      };
    } else if (description.includes('sun') || description.includes('bright') || mood.includes('optimistic')) {
      return {
        description: 'Clear, bright conditions',
        atmospherics: 'Crisp, clear atmosphere with sharp shadows and vibrant colors'
      };
    } else if (description.includes('fog') || description.includes('mist')) {
      return {
        description: 'Light atmospheric haze',
        atmospherics: 'Soft, diffused lighting with reduced visibility in background layers'
      };
    } else {
      return {
        description: 'Typical weather conditions for the region',
        atmospherics: `Standard atmospheric conditions appropriate for ${countryContext.primaryCountry} geographical location and season`
      };
    }
  }

  // Phase 4: Video Generation with Enhanced Content Safety
  async generateSceneVideos(sceneImages) {
    const sceneVideos = [];

    for (const scene of sceneImages) {
      try {
        console.log(`🎥 Generating family-friendly video for scene ${scene.sceneNumber}`);

        // Generate motion description using GPT-4 with enhanced safety focus
        const motionSystemPrompt = `You are a family-friendly animation director creating gentle, positive motion descriptions for Disney-style video generation. Focus exclusively on calm, professional, constructive movements suitable for all audiences. Emphasize coordination, cooperation, and positive civic activities.`;
        
        const motionUserPrompt = `Create gentle, family-friendly motion for this positive community scene:
        ${scene.description}
        
        CRITICAL FAMILY-FRIENDLY REQUIREMENTS:
        - Focus ONLY on positive coordination, planning, and community cooperation
        - Show professional collaboration and constructive teamwork
        - Emphasize helpful assistance and positive civic engagement
        - All activities should appear constructive and supportive
        - Present all interactions as positive professional coordination
        - Focus on community support and collaborative problem-solving
        
        GENTLE MOVEMENT REQUIREMENTS:
        - ONLY very subtle, slow, positive movements
        - NO fast movements, sudden motions, or dramatic gestures
        - Focus on calm, professional coordination activities
        - Scene type: ${scene.sceneType}
        - Scene duration: ${scene.duration} seconds
        
        Family-friendly gentle movements:
        - Gentle head nods during positive discussions
        - Slow camera pans showing organized coordination activities
        - Professional team members working together calmly
        - Community leaders planning and coordinating constructively
        - People collaborating and supporting each other positively
        - Gradual lighting changes showing pleasant atmosphere
        - Slow eye movements showing focus and positive concentration
        - Gentle hand gestures indicating coordination and cooperation
        - Calm walking movements showing purposeful coordination
        - Pleasant expressions showing positive engagement
        
        COMPLETELY AVOID:
        - Any rapid or sudden movements
        - Any gestures that could appear confrontational
        - Fast camera movements or dramatic motion
        - Any motion that could appear tense or stressful
        - Quick hand gestures or rapid talking
        - Any movement suggesting urgency or stress
        - Motion that could cause visual distortion
        
        Provide a positive, family-friendly motion description (max 150 characters) focusing on gentle, constructive, collaborative movements that emphasize community cooperation and positive coordination.`;

        const motionResponse = await this.openai.responses.parse({
          model: "gpt-4o-2024-08-06",
          input: [
            { role: "system", content: motionSystemPrompt },
            { role: "user", content: motionUserPrompt }
          ],
          text: {
            format: zodTextFormat(MotionDescriptionSchema, "motion")
          }
        });

        let motionDescription = motionResponse.output_parsed.motionDescription;

        // Enhance prompt for family-friendly Disney quality
        const enhancedPrompt = this.enhancePromptForFamilyFriendlyDisney(motionDescription, scene);

        // Convert local image file to a format APIs can use
        const imageUrl = await this.convertLocalImageForKlingAI(scene.image);

        // Generate video using Kling AI with family-friendly fallback strategy
        const result = await KlingAI.generateVideoWithFallback(
          imageUrl,
          enhancedPrompt,
          scene.duration,
          scene.sceneType
        );

        // Download video locally
        const videoPath = path.join(this.workingDir, 'videos', `scene_${scene.sceneNumber}_${uuidv4()}.mp4`);
        await KlingAI.downloadVideo(result.videoUrl, videoPath);
        
        sceneVideos.push({
          sceneNumber: scene.sceneNumber,
          videoPath: videoPath,
          narration: scene.narration,
          duration: scene.duration,
          klingTaskId: result.taskId
        });

        console.log(`✅ Family-friendly scene ${scene.sceneNumber} video generated successfully`);

      } catch (error) {
        console.error(`Error generating video for scene ${scene.sceneNumber}:`, error);
        throw new Error(`Failed to generate video for scene: ${scene.sceneNumber}`);
      }
    }

    return sceneVideos;
  }

  // Enhanced family-friendly Disney prompt generation
  enhancePromptForFamilyFriendlyDisney(basePrompt, sceneContext) {
    const familyFriendlyKeywords = [
      'Disney/Pixar 3D animation visual style',
      'positive and constructive',
      'gentle movements only',
      'high-quality family-friendly rendering',
      'warm professional lighting',
      'community cooperation appropriate content',
      'calm coordination motion',
      'collaborative teamwork focus',
      'positive civic engagement',
      'constructive professional activities'
    ];

    const gentleCameraKeywords = {
      'emotional': 'gentle close-up with minimal camera movement showing positive focus',
      'action': 'slow, steady camera movement following positive coordination activities',
      'landscape': 'very slow establishing shot showing pleasant community environment',
      'dialogue': 'static shot with subtle focus on positive conversation',
      'standard': 'gentle, minimal camera movement highlighting professional cooperation'
    };

    let enhanced = basePrompt;
    enhanced += `, ${familyFriendlyKeywords.join(', ')}`;
    
    if (sceneContext.mood) {
      const safeMood = sceneContext.mood.replace(/serious|urgent|concerned/gi, 'focused professional');
      enhanced += `, positive ${safeMood} coordination atmosphere`;
    }
    
    if (sceneContext.sceneType && gentleCameraKeywords[sceneContext.sceneType]) {
      enhanced += `, ${gentleCameraKeywords[sceneContext.sceneType]}`;
    }

    enhanced += ', extremely gentle and slow movements emphasizing positive cooperation and community coordination';

    // Additional safety sanitization for video generation
    enhanced = enhanced
      .replace(/emergency|crisis|urgent/gi, 'coordination')
      .replace(/investigation|probe|examine/gi, 'planning coordination')
      .replace(/response|aftermath/gi, 'community coordination')
      .replace(/concern|worry|anxiety/gi, 'focused attention')
      .replace(/serious|grave|critical/gi, 'important coordination')
      .replace(/impact|effect|consequence/gi, 'community coordination result');

    return enhanced;
  }

  // Phase 5: Audio Generation (unchanged)
  async generateAudioAssets(scenes, overallMood) {
    try {
      console.log('🎵 Generating audio assets...');

      // Generate narration for each scene
      const narrationPaths = [];

      const voiceIds = [
        'EXAVITQu4vr4xnSDxMaL', // Sarah
        'pFZP5JQG7iQjIQuC4Bku', // Lily
        'aXbjk4JoIDXdCNz29TrS', // Sunny
        'onwK4e9ZLuTAKqWW03F9' // Daniel
      ]
      const selectedVoiceId = voiceIds[Math.floor(Math.random() * voiceIds.length)]
      
      for (const scene of scenes) {
        if (scene.narration && scene.narration.trim()) {
          const audioPath = await this.generateVoice(scene.narration, scene.sceneNumber, selectedVoiceId);
          if (audioPath) {
            narrationPaths.push({
              sceneNumber: scene.sceneNumber,
              audioPath: audioPath,
              duration: scene.duration
            });
          }
        }
      }

      return {
        narration: narrationPaths,
      };

    } catch (error) {
      console.error('Error generating audio assets:', error);
      throw new Error('Failed to generate audio assets');
    }
  }

  // Phase 6: Updated Video Assembly (unchanged)
  async assembleAnimation(sceneVideos, audioAssets, storyData) {
    try {
      console.log('🎬 Assembling final animation with audio-video sync and subtitles...');
      
      const processedClipsDir = path.join(this.workingDir, 'processed');
      await fs.mkdir(processedClipsDir, { recursive: true });
      
      const processedClips = [];
      const totalClips = sceneVideos.length;

      // Step 1: Process each scene (trim video to audio length, add subtitles)
      console.log('📝 Processing individual scenes...');
      
      for (let i = 0; i < sceneVideos.length; i++) {
        const sceneVideo = sceneVideos[i];
        const sceneAudio = audioAssets.narration.find(n => n.sceneNumber === sceneVideo.sceneNumber);
        
        if (!sceneAudio || !sceneAudio.audioPath) {
          console.warn(`⚠️ No audio found for scene ${sceneVideo.sceneNumber}, skipping processing`);
          continue;
        }

        console.log(`🔧 Processing scene ${sceneVideo.sceneNumber}/${totalClips}...`);
        
        const processedClipPath = path.join(processedClipsDir, `processed_scene_${sceneVideo.sceneNumber}.mp4`);
        
        // Trim and mux with subtitles
        const actualDuration = await this.trimAndMux({
          video: sceneVideo.videoPath,
          audio: sceneAudio.audioPath,
          subtitleText: sceneVideo.narration,
          out: processedClipPath,
          idx: i,
          totalClips: totalClips,
          fadeTime: 0.5
        });

        processedClips.push({
          sceneNumber: sceneVideo.sceneNumber,
          path: processedClipPath,
          duration: actualDuration
        });

        console.log(`✅ Scene ${sceneVideo.sceneNumber} processed (${actualDuration}s)`);
      }

      if (processedClips.length === 0) {
        throw new Error('No clips were successfully processed');
      }

      // Step 2: Create concat file for FFmpeg
      console.log('🔗 Concatenating processed clips...');
      
      const concatFilePath = path.join(this.workingDir, 'concat_list.txt');
      const concatContent = processedClips
        .sort((a, b) => a.sceneNumber - b.sceneNumber)
        .map(clip => `file '${clip.path.replace(/\\/g, '/')}'`)
        .join('\n');
      
      writeFileSync(concatFilePath, concatContent, 'utf8');
      console.log(`📋 Concat file created with ${processedClips.length} clips`);

      // Step 3: Concatenate all processed clips
      const outputPath = path.join(this.workingDir, `animation_${uuidv4()}.mp4`);
      
      return new Promise((resolve, reject) => {
        const ffArgs = [
          '-f', 'concat',
          '-safe', '0',
          '-i', concatFilePath,
          '-c', 'copy',
          '-movflags', '+faststart',
          outputPath
        ];

        console.log(`🎞️ Final concatenation: ffmpeg ${ffArgs.join(' ')}`);

        const { status, error } = spawnSync('ffmpeg', ffArgs, { stdio: 'inherit' });
        
        if (status !== 0) {
          console.error('❌ Final concatenation failed:', error);
          reject(new Error(`Final concatenation failed with status ${status}`));
          return;
        }

        // Cleanup concat file
        try {
          unlinkSync(concatFilePath);
        } catch (cleanupError) {
          console.warn('Warning: Could not cleanup concat file:', cleanupError.message);
        }

        const totalDuration = processedClips.reduce((sum, clip) => sum + clip.duration, 0);
        console.log(`✅ Animation assembly completed! Total duration: ${totalDuration.toFixed(1)}s`);
        console.log(`📁 Output: ${outputPath}`);
        
        resolve(outputPath);
      });

    } catch (error) {
      console.error('❌ Error assembling animation:', error);
      throw new Error(`Failed to assemble animation: ${error.message}`);
    }
  }

  // INTELLIGENT: Story-Aware Content Adaptation (preserves story integrity while ensuring visual safety)
  sanitizeSceneForContentPolicy(sceneDescription, sceneType) {
    // Determine story type to apply appropriate visual adaptations
    const storyType = this.detectStoryType(sceneDescription);
    console.log("Story Type", storyType)
    
    let sanitizedDescription = sceneDescription;
    let wasModified = false;

    // Apply story-type specific visual adaptations (keep narration intact)
    switch (storyType) {
      case 'crime':
        ({ sanitizedDescription, wasModified } = this.adaptCrimeSceneVisuals(sceneDescription));
        break;
      case 'accident':
        ({ sanitizedDescription, wasModified } = this.adaptAccidentSceneVisuals(sceneDescription));
        break;
      case 'conflict':
        ({ sanitizedDescription, wasModified } = this.adaptConflictSceneVisuals(sceneDescription));
        break;
      case 'emergency':
        ({ sanitizedDescription, wasModified } = this.adaptEmergencySceneVisuals(sceneDescription));
        break;
      case 'investigation':
        ({ sanitizedDescription, wasModified } = this.adaptInvestigationSceneVisuals(sceneDescription));
        break;
      default:
        // For general news, apply light sanitization only if needed
        ({ sanitizedDescription, wasModified } = this.adaptGeneralSceneVisuals(sceneDescription));
        break;
    }

    if (wasModified) {
      console.log(`🎬 Scene visuals adapted for ${storyType} story while preserving narrative integrity`);
    }

    return {
      sanitizedDescription,
      wasModified,
      storyType
    };
  }

  // Helper method to detect story type from scene description
  detectStoryType(description) {
    const lowerDesc = description.toLowerCase();
    
    if (lowerDesc.includes('crime') || lowerDesc.includes('murder') || lowerDesc.includes('robbery') || 
        lowerDesc.includes('theft') || lowerDesc.includes('arrest') || lowerDesc.includes('suspect') ||
        lowerDesc.includes('police') || lowerDesc.includes('investigation') || lowerDesc.includes('evidence')) {
      return 'crime';
    }
    
    if (lowerDesc.includes('accident') || lowerDesc.includes('crash') || lowerDesc.includes('collision') ||
        lowerDesc.includes('emergency') || lowerDesc.includes('ambulance') || lowerDesc.includes('hospital')) {
      return 'accident';
    }
    
    if (lowerDesc.includes('protest') || lowerDesc.includes('riot') || lowerDesc.includes('clash') ||
        lowerDesc.includes('demonstration') || lowerDesc.includes('conflict')) {
      return 'conflict';
    }
    
    if (lowerDesc.includes('fire') || lowerDesc.includes('disaster') || lowerDesc.includes('rescue') ||
        lowerDesc.includes('evacuation') || lowerDesc.includes('emergency')) {
      return 'emergency';
    }
    
    if (lowerDesc.includes('investigation') || lowerDesc.includes('probe') || lowerDesc.includes('inquiry') ||
        lowerDesc.includes('court') || lowerDesc.includes('trial') || lowerDesc.includes('hearing')) {
      return 'investigation';
    }
    
    return 'general';
  }

  // Adapt crime story visuals (show investigation/aftermath, not the crime itself)
  adaptCrimeSceneVisuals(description) {
    const crimeVisualAdaptations = {
      // Replace direct crime depictions with investigation/aftermath
      'murder scene': 'police investigation area with evidence markers',
      'shooting': 'police investigation with officers documenting the scene',
      'robbery in progress': 'police officers interviewing witnesses',
      'break-in': 'security personnel examining the affected area',
      'assault': 'medical personnel providing assistance',
      'attack': 'emergency response team coordinating',
      'violence': 'police officers taking statements from witnesses',
      'stabbing': 'emergency medical response scene',
      'gunshot': 'police investigation and evidence collection',
      'weapon': 'police evidence collection team working',
      'blood': 'forensic investigation team documenting evidence',
      'victim': 'medical personnel providing care and assistance',
      'perpetrator': 'police officer discussing the case',
      'suspect being arrested': 'police officers in professional discussion',
      'fight': 'police officers interviewing witnesses',
      'threatening': 'police officers taking witness statements'
    };

    let adaptedDescription = description;
    let wasModified = false;

    // Apply visual adaptations while preserving story context
    for (const [crimeVisual, safeVisual] of Object.entries(crimeVisualAdaptations)) {
      const regex = new RegExp(crimeVisual, 'gi');
      if (regex.test(adaptedDescription)) {
        adaptedDescription = adaptedDescription.replace(regex, safeVisual);
        wasModified = true;
      }
    }

    // Focus on investigation and response rather than the crime action
    adaptedDescription = adaptedDescription
      .replace(/\b(committing|performing|executing)\s+(a\s+)?(crime|murder|robbery)\b/gi, 'investigating the reported incident')
      .replace(/\b(during|while)\s+the\s+(attack|assault|crime)\b/gi, 'during the investigation')
      .replace(/\b(scene\s+of\s+the\s+)(crime|murder|attack)\b/gi, 'investigation area')
      .replace(/\b(criminal|perpetrator)\s+(escaping|fleeing)\b/gi, 'police coordinating response efforts');

    return { sanitizedDescription: adaptedDescription, wasModified };
  }

  // Adapt accident story visuals (show response/aftermath, not the accident moment)
  adaptAccidentSceneVisuals(description) {
    const accidentVisualAdaptations = {
      'car crash': 'emergency responders at the accident site',
      'collision': 'traffic officials documenting the incident',
      'vehicle accident': 'emergency medical team providing assistance',
      'plane crash': 'emergency response coordination at the airport',
      'train derailment': 'railway safety officials examining the area',
      'explosion': 'emergency response team securing the area',
      'fire': 'firefighters and emergency personnel at the scene',
      'building collapse': 'rescue workers coordinating search efforts',
      'injured victims': 'medical personnel providing emergency care',
      'casualties': 'emergency medical response team',
      'wreckage': 'investigation team examining the affected area',
      'debris': 'cleanup crews working to clear the area'
    };

    let adaptedDescription = description;
    let wasModified = false;

    for (const [accidentVisual, safeVisual] of Object.entries(accidentVisualAdaptations)) {
      const regex = new RegExp(accidentVisual, 'gi');
      if (regex.test(adaptedDescription)) {
        adaptedDescription = adaptedDescription.replace(regex, safeVisual);
        wasModified = true;
      }
    }

    return { sanitizedDescription: adaptedDescription, wasModified };
  }

  // Adapt conflict story visuals (show dialogue/peaceful resolution, not confrontation)
  adaptConflictSceneVisuals(description) {
    const conflictVisualAdaptations = {
      'violent protest': 'peaceful demonstration with community leaders',
      'riot': 'community dialogue session',
      'clash between': 'meeting between representatives of',
      'fighting': 'discussing and negotiating',
      'confrontation': 'dialogue session',
      'aggressive crowd': 'gathered community members',
      'protesters throwing': 'protesters peacefully demonstrating',
      'police in riot gear': 'police officers maintaining public safety',
      'tear gas': 'crowd management measures',
      'barricades': 'organized demonstration area'
    };

    let adaptedDescription = description;
    let wasModified = false;

    for (const [conflictVisual, safeVisual] of Object.entries(conflictVisualAdaptations)) {
      const regex = new RegExp(conflictVisual, 'gi');
      if (regex.test(adaptedDescription)) {
        adaptedDescription = adaptedDescription.replace(regex, safeVisual);
        wasModified = true;
      }
    }

    return { sanitizedDescription: adaptedDescription, wasModified };
  }

  // Adapt emergency story visuals (show response/coordination, not the emergency itself)
  adaptEmergencySceneVisuals(description) {
    const emergencyVisualAdaptations = {
      'building on fire': 'firefighters coordinating response at the building',
      'people trapped': 'rescue workers organizing evacuation procedures',
      'rescue operation': 'emergency response team coordination',
      'evacuation': 'emergency personnel guiding people to safety',
      'disaster zone': 'emergency response coordination area',
      'emergency sirens': 'emergency vehicles positioned for response',
      'panic': 'organized emergency response',
      'chaos': 'coordinated emergency management'
    };

    let adaptedDescription = description;
    let wasModified = false;

    for (const [emergencyVisual, safeVisual] of Object.entries(emergencyVisualAdaptations)) {
      const regex = new RegExp(emergencyVisual, 'gi');
      if (regex.test(adaptedDescription)) {
        adaptedDescription = adaptedDescription.replace(regex, safeVisual);
        wasModified = true;
      }
    }

    return { sanitizedDescription: adaptedDescription, wasModified };
  }

  // Adapt investigation story visuals (show professional procedures)
  adaptInvestigationSceneVisuals(description) {
    const investigationVisualAdaptations = {
      'crime scene': 'investigation area with professional documentation',
      'evidence collection': 'forensic team professional documentation',
      'interrogation': 'professional interview session',
      'suspect questioning': 'police interview room',
      'witness testimony': 'formal statement session',
      'court hearing': 'professional legal proceedings',
      'trial': 'formal judicial session'
    };

    let adaptedDescription = description;
    let wasModified = false;

    for (const [investigationVisual, safeVisual] of Object.entries(investigationVisualAdaptations)) {
      const regex = new RegExp(investigationVisual, 'gi');
      if (regex.test(adaptedDescription)) {
        adaptedDescription = adaptedDescription.replace(regex, safeVisual);
        wasModified = true;
      }
    }

    return { sanitizedDescription: adaptedDescription, wasModified };
  }

  // Light adaptations for general news (minimal changes)
  adaptGeneralSceneVisuals(description) {
    // Only apply very light modifications for clearly problematic visuals
    const generalAdaptations = {
      'graphic images': 'professional documentation',
      'disturbing scenes': 'investigation area',
      'violent imagery': 'response coordination'
    };

    let adaptedDescription = description;
    let wasModified = false;

    for (const [problematicVisual, safeVisual] of Object.entries(generalAdaptations)) {
      const regex = new RegExp(problematicVisual, 'gi');
      if (regex.test(adaptedDescription)) {
        adaptedDescription = adaptedDescription.replace(regex, safeVisual);
        wasModified = true;
      }
    }

    return { sanitizedDescription: adaptedDescription, wasModified };
  }

  // Helper methods (unchanged)
  async generateImage(prompt) {
    try {
      const response = await this.openai.images.generate({
        model: 'gpt-image-1',
        prompt: prompt,
        size: '1536x1024',
        quality: 'medium',
        n: 1,
        moderation: 'low'
      });

      const base64Data = response.data[0].b64_json;
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const tempImagePath = path.join(this.workingDir, `temp_image_${uuidv4()}.png`);
      
      await fs.writeFile(tempImagePath, imageBuffer);
      
      console.log(`✅ Image generated with gpt-image-1 (${response.usage?.total_tokens || 'N/A'} tokens)`);
      
      return tempImagePath;
    } catch (error) {
      console.error('Error generating image:', error);
      throw new Error('Failed to generate image');
    }
  }

  async generateImageWithReference(referenceImagePaths, prompt) {
    try {
      console.log(`🖼️ Generating image with ${referenceImagePaths.length} reference images`);

      const imageFiles = await Promise.all(
        referenceImagePaths.map(async (imagePath) => {
          return await toFile(fsSync.createReadStream(imagePath), null, {
            type: "image/png",
          });
        })
      );

      const response = await this.openai.images.edit({
        model: 'gpt-image-1',
        image: imageFiles,
        prompt: prompt,
        size: '1536x1024',
        quality: 'medium',
      });

      const base64Data = response.data[0].b64_json;
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const tempImagePath = path.join(this.workingDir, `temp_ref_image_${uuidv4()}.png`);
      
      await fs.writeFile(tempImagePath, imageBuffer);
      
      console.log(`✅ Reference image generated with gpt-image-1 (${response.usage?.total_tokens || 'N/A'} tokens)`);
      
      return tempImagePath;
    } catch (error) {
      console.error('Error generating image with reference:', error);
      console.log('🔄 Falling back to generation without reference images');
      return await this.generateImage(prompt);
    }
  }

  async generateVoice(text, sceneNumber, selectedVoiceId) {
    try {
        console.log("This is text", text)
      if (!this.elevenLabsApiKey) {
        console.warn('ElevenLabs API key not found, skipping voice generation');
        return null;
      }

      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}`,
        {
          text: text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true
          }
        },
        {
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': this.elevenLabsApiKey
          },
          responseType: 'arraybuffer'
        }
      );

      const audioPath = path.join(this.workingDir, 'audio', `narration_${sceneNumber}.mp3`);
      await fs.writeFile(audioPath, Buffer.from(response.data));
      return audioPath;

    } catch (error) {
      console.error('Error generating voice:', error);
      return null;
    }
  }

  async generateBackgroundMusic(mood, duration) {
    try {
      const musicPath = path.join(this.workingDir, 'audio', 'background_music.mp3');
      
      return new Promise((resolve, reject) => {
        ffmpeg()
          .input('anullsrc=channel_layout=stereo:sample_rate=48000')
          .inputFormat('lavfi')
          .duration(duration)
          .output(musicPath)
          .on('end', () => resolve(musicPath))
          .on('error', reject)
          .run();
      });

    } catch (error) {
      console.error('Error generating background music:', error);
      return null;
    }
  }

  async convertLocalImageForKlingAI(localImagePath) {
    try {
    //   if (this.imagekitApiKey && this.imagekitPrivateKey && this.imagekitEndpoint) {
    //     const tempFileName = `temp_${uuidv4()}.png`;
    //     const tempUrl = await this.uploadToImageKit(localImagePath, tempFileName);
    //     return tempUrl;
    //   }
      
      const imageBuffer = await fs.readFile(localImagePath);
      const base64Data = imageBuffer.toString('base64');
      return `data:image/png;base64,${base64Data}`;
      
    } catch (error) {
      console.error('Error converting local image for Kling AI:', error);
      throw new Error('Failed to convert local image for Kling AI');
    }
  }

  async downloadImage(url, filename) {
    try {
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer'
      });

      const imagePath = path.join(this.workingDir, filename);
      await fs.writeFile(imagePath, response.data);
      return imagePath;

    } catch (error) {
      console.error('Error downloading image:', error);
      throw new Error('Failed to download image');
    }
  }

  async saveImageAsset(imagePathOrUrl, filename) {
    try {
      const targetPath = path.join(this.workingDir, filename);
      
      const dir = path.dirname(targetPath);
      await fs.mkdir(dir, { recursive: true });
      
      if (imagePathOrUrl.startsWith('http')) {
        await this.downloadImage(imagePathOrUrl, filename);
      } else {
        await fs.copyFile(imagePathOrUrl, targetPath);
      }
      
      return targetPath;
    } catch (error) {
      console.error('Error saving image asset:', error);
      throw new Error('Failed to save image asset');
    }
  }

  async uploadToImageKit(filePath, fileName) {
    try {
      if (!this.imagekitApiKey || !this.imagekitPrivateKey || !this.imagekitEndpoint) {
        throw new Error('ImageKit configuration missing');
      }

      const ImageKit = require('imagekit');
      
      const imagekit = new ImageKit({
        publicKey: this.imagekitApiKey,
        privateKey: this.imagekitPrivateKey,
        urlEndpoint: this.imagekitEndpoint
      });

      const fileData = await fs.readFile(filePath);

      const uploadResponse = await imagekit.upload({
        file: fileData,
        fileName: fileName,
        folder: '/animations/'
      });

      return uploadResponse.url;

    } catch (error) {
      console.error('Error uploading to ImageKit:', error);
      throw new Error('Failed to upload to ImageKit');
    }
  }

  async saveAnimationToDatabase(animationData, finalVideoUrl) {
    try {
      const animation = new Animation({
        title: animationData.title,
        theme: animationData.theme,
        article: animationData.originalArticle,
        sceneCount: animationData.scenes.length,
        characters: animationData.characters,
        scenes: animationData.scenes,
        videoUrl: finalVideoUrl,
        status: 'completed',
        generatedAt: new Date(),
        processingTime: animationData.processingTime
      });

      await animation.save();
      return animation;

    } catch (error) {
      console.error('Error saving animation to database:', error);
      throw new Error('Failed to save animation to database');
    }
  }

  // UPDATED: Main pipeline execution with country context
  async generateAnimation(article, sceneCount) {
    const startTime = Date.now();
    let finalVideoPath = null;
    
    try {
      console.log('🎬 Starting country-aware family-friendly Disney animation generation pipeline with detailed scenes, minimal text, and comprehensive content safety...');
      console.log(`📄 Article length: ${article.length} characters`);
      console.log(`🎭 Scenes to generate: ${sceneCount}`);

      // Phase 1: Story Development with Country Detection
      console.log('\n📝 Phase 1: Generating country-aware story structure...');
      const storyData = await this.generateStoryStructure(article, sceneCount);
      storyData.originalArticle = article;
      console.log(`✅ Story created: "${storyData.title}"`);
      console.log(`🌍 Country context: ${storyData.countryContext.primaryCountry}`);

      // Phase 2: Character Generation with Country Context
      console.log('\n🎭 Phase 2: Generating country-appropriate character assets...');
      const characterAssets = await this.generateCharacterAssets(storyData.characters, storyData.countryContext);
      console.log(`✅ Generated ${Object.keys(characterAssets).length} characters for ${storyData.countryContext.primaryCountry}`);

      // Phase 3: Scene Generation with Country Context and Minimal Text
      console.log('\n🖼️ Phase 3: Generating country-authentic detailed scene images with minimal text...');
      const sceneImages = await this.generateSceneImages(storyData.scenes, characterAssets, storyData.countryContext);
      console.log(`✅ Generated ${sceneImages.length} ${storyData.countryContext.primaryCountry}-authentic detailed scene images with minimal text`);

      // Phase 4: Video Generation
      console.log('\n🎥 Phase 4: Generating scene videos with Kling AI...');
      const sceneVideos = await this.generateSceneVideos(sceneImages);
      console.log(`✅ Generated ${sceneVideos.length} scene videos`);

      // Phase 5: Audio Generation
      console.log('\n🎵 Phase 5: Generating audio assets...');
      const audioAssets = await this.generateAudioAssets(storyData.scenes, storyData.overallMood);
      console.log(`✅ Generated audio for ${audioAssets.narration.length} scenes`);

      // Phase 6: Video Assembly with Audio-Video Sync and Subtitles
      console.log('\n🎬 Phase 6: Assembling final animation with audio sync and subtitles...');
      finalVideoPath = await this.assembleAnimation(sceneVideos, audioAssets, storyData);
      console.log('✅ Animation assembly completed', finalVideoPath);

      // Save to permanent location
      const outputDir = path.join(process.cwd(), 'public', 'animations');
      await fs.mkdir(outputDir, { recursive: true });
      
      const permanentVideoFileName = `animation_${Date.now()}_${uuidv4()}.mp4`;
      const permanentVideoPath = path.join(outputDir, permanentVideoFileName);
      
      // Copy final video to permanent location
      await fs.copyFile(finalVideoPath, permanentVideoPath);
      console.log(`📁 Final video saved to: ${permanentVideoPath}`);

      // Save to database with local file path
      const processingTime = Date.now() - startTime;
      storyData.processingTime = processingTime;
      
      const animationRecord = await this.saveAnimationToDatabase(storyData, permanentVideoPath);

      console.log(`\n🎉 Country-aware family-friendly animation generation with detailed scenes and minimal text completed successfully!`);
      console.log(`🌍 Generated for: ${storyData.countryContext.primaryCountry}${storyData.countryContext.primaryCity ? ` (${storyData.countryContext.primaryCity})` : ''}`);
      console.log(`📝 Text content minimized for clean visual composition`);
      console.log(`🎬 Detailed family-friendly scene descriptions used for enhanced image control`);
      console.log(`🛡️ All content optimized for comprehensive content safety compliance`);
      console.log(`⏱️ Total processing time: ${(processingTime / 1000 / 60).toFixed(1)} minutes`);
      console.log(`📂 Final video path: ${permanentVideoPath}`);
      
      return {
        success: true,
        animationId: animationRecord._id,
        videoPath: permanentVideoPath,
        videoUrl: permanentVideoPath,
        title: storyData.title,
        processingTime: processingTime,
        sceneCount: storyData.scenes.length,
        countryContext: storyData.countryContext
      };

    } catch (error) {
        console.error('❌ Animation generation failed:', error);
      
        // Cleanup on error (but preserve permanent video if it exists)
        if (finalVideoPath) {
          try {
            // Only delete the temp video if it exists and is different from permanent location
            const outputDir = path.join(process.cwd(), 'public', 'animations');
            if (!finalVideoPath.startsWith(outputDir)) {
              await fs.unlink(finalVideoPath);
            }
          } catch (cleanupError) {
            console.error('Error cleaning up video file:', cleanupError);
          }
        }
        
        throw new Error(`Animation generation failed: ${error.message}`);
    }
  }

  async cleanupTempFiles() {
    try {
      console.log('🧹 Cleaning up all temporary files and directories...');
      
      // Since the final video is now saved in public/animations/, 
      // we can safely delete the entire temp working directory
      const tempDirExists = await fs.access(this.workingDir).then(() => true).catch(() => false);
      
      if (tempDirExists) {
        // Remove the entire temp working directory and all its contents
        await fs.rm(this.workingDir, { recursive: true, force: true });
        console.log(`✅ Deleted entire temp directory: ${this.workingDir}`);
        
        // Recreate the basic structure for next use
        await this.ensureDirectoryExists();
        console.log('📁 Recreated basic temp directory structure');
      } else {
        console.log('ℹ️ Temp directory does not exist, skipping cleanup');
      }
      
      console.log('✅ Cleanup completed - Final video preserved in public/animations/');
    } catch (error) {
      console.error('❌ Error during temp files cleanup:', error);
      // Don't throw error as this is cleanup - log and continue
    }
  }
}

module.exports = new AnimationService();