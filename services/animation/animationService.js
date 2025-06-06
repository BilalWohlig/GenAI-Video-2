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

  // UPDATED: Phase 3: Scene Generation with Country Context
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

        if (scene.characters && scene.characters.length > 0) {
          // Build character reference mapping
          let characterReferences = [];
          
          scene.characters.forEach((charName, index) => {
            if (characterAssets[charName] && characterAssets[charName].master) {
              referenceImages.push(characterAssets[charName].master);
              characterReferences.push(`${charName}(image ${index + 1})`);
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

        // Build complete realistic scene prompt with country context
        let fullScenePrompt = `
        Realistic news scene in Disney/Pixar 3D animation style: ${enhancedPrompt}
        Location: ${scene.location}
        Mood: ${scene.mood}
        Camera angle: ${scene.cameraAngle}
        
        COUNTRY-SPECIFIC AUTHENTICITY FOR ${countryContext.primaryCountry}:
        🏛️ Architecture: ${countryContext.architecturalStyle}
        🌍 Cultural Setting: ${countryContext.culturalContext}
        🗣️ Signage/Text: ${countryContext.languageContext}
        👥 Background People: ${countryContext.demographicNotes}
        
        Ensure the scene authentically represents ${countryContext.primaryCountry}:
        - Buildings and infrastructure should match ${countryContext.architecturalStyle}
        - Street scenes should include typical ${countryContext.primaryCountry} elements (vehicles, street furniture, etc.)
        - Background characters should reflect local demographics
        - Signage and text should be in appropriate language(s)
        - Environmental details should be culturally accurate
        - Weather and lighting appropriate for the region
        
        High quality 3D rendering, professional lighting, detailed realistic environment, 
        Disney/Pixar animation visual quality, vibrant but realistic colors, engaging composition.
        
        IMPORTANT CONTENT GUIDELINES:
        - Keep everything REALISTIC and NEWS-APPROPRIATE
        - Focus on aftermath, response, and community impact rather than violent actions
        - Show emergency responders, investigators, and community support
        - Avoid graphic content, violence, or disturbing imagery
        - Professional, family-friendly presentation suitable for news broadcast
        - No weapons, blood, or explicit violence - focus on response and recovery
        - Emphasize human resilience, community support, and professional response
        
        REALISTIC REQUIREMENTS:
        - No magical elements, fantasy creatures, or fictional aspects
        - Professional, real-world setting appropriate for news content in ${countryContext.primaryCountry}
        - Realistic human characters in appropriate professional attire for ${countryContext.primaryCountry}
        - Modern, contemporary ${countryContext.primaryCountry} environments (offices, laboratories, city streets, etc.)
        - Maintain journalistic accuracy and cultural authenticity
        
        Maintain character consistency with the reference images. Keep the exact same character designs, 
        colors, and physical features from the reference images. Ensure professional, realistic appearance
        appropriate for ${countryContext.primaryCountry} context.`;

        let sceneImagePath;

        if (referenceImages.length > 0) {
          // Generate scene with character references
          console.log(`   Using ${referenceImages.length} character reference images for ${countryContext.primaryCountry}-authentic scene`);
          sceneImagePath = await this.generateImageWithReference(referenceImages, fullScenePrompt);
        } else {
          // Generate scene without character references
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
          countryContext: countryContext
        });

        // Copy to permanent scene directory
        const permanentPath = path.join(this.workingDir, 'scenes', `scene_${scene.sceneNumber}.png`);
        await fs.copyFile(sceneImagePath, permanentPath);

        if (wasModified) {
          console.log(`✅ Content-safe ${countryContext.primaryCountry}-authentic scene ${scene.sceneNumber} generated (content modified for safety)`);
        } else {
          console.log(`✅ ${countryContext.primaryCountry}-authentic scene ${scene.sceneNumber} generated with ${scene.characters?.length || 0} character references`);
        }

      } catch (error) {
        console.error(`Error generating scene ${scene.sceneNumber}:`, error);
        throw new Error(`Failed to generate scene: ${scene.sceneNumber}`);
      }
    }

    return sceneImages;
  }

  // Phase 4: Video Generation with Kling AI (unchanged)
  async generateSceneVideos(sceneImages) {
    const sceneVideos = [];

    for (const scene of sceneImages) {
      try {
        console.log(`🎥 Generating video for scene ${scene.sceneNumber}`);

        // Generate motion description using GPT-4 with structured response
        const motionSystemPrompt = `You are a professional news animation director. Create subtle, family-friendly motion descriptions for video generation that avoid both fast movements and any content that could be flagged as sensitive. Focus on gentle, professional movements suitable for broadcast news.`;
        
        const motionUserPrompt = `Create subtle, content-safe motion for this news scene:
        ${scene.description}
        
        CRITICAL CONTENT SAFETY REQUIREMENTS:
        - Focus on AFTERMATH, RESPONSE, and RECOVERY rather than violent actions
        - Show emergency responders, investigators, community support
        - Avoid any depiction of violence, weapons, or graphic content
        - Emphasize human resilience and professional response
        - Keep content family-friendly and broadcast-appropriate
        
        CRITICAL MOVEMENT REQUIREMENTS:
        - ONLY subtle, slow movements to avoid video distortion
        - NO fast movements, quick cuts, or rapid motion
        - Focus on gentle, professional movements suitable for news
        - Scene type: ${scene.sceneType}
        - Scene duration: ${scene.duration} seconds
        
        Content-safe subtle movements:
        - Gentle head nods during interviews
        - Slow camera pans over aftermath/debris (no violence)
        - Emergency responders working calmly
        - Officials discussing or investigating
        - Community members supporting each other
        - Gradual lighting changes or atmospheric effects
        - Slow eye movements showing concern or focus
        
        AVOID:
        - Any violent actions or weapons
        - Fast movements, running, chaos
        - Graphic or disturbing content
        - Quick hand gestures or rapid talking
        - Fast camera movements or shaking
        - Any motion that could cause distortion
        
        Provide a concise, content-safe motion description (max 150 characters) focusing on subtle, professional, family-friendly movements.`;

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

        // Enhance prompt for Disney quality
        const enhancedPrompt = this.enhancePromptForDisney(motionDescription, scene);

        // Convert local image file to a format APIs can use
        const imageUrl = await this.convertLocalImageForKlingAI(scene.image);

        // Generate video using Kling AI with fallback strategy
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

        console.log(`✅ Scene ${scene.sceneNumber} video generated successfully`);

      } catch (error) {
        console.error(`Error generating video for scene ${scene.sceneNumber}:`, error);
        throw new Error(`Failed to generate video for scene: ${scene.sceneNumber}`);
      }
    }

    return sceneVideos;
  }

  // Enhanced Disney prompt generation (unchanged)
  enhancePromptForDisney(basePrompt, sceneContext) {
    const realisticNewsKeywords = [
      'Disney/Pixar 3D animation visual style',
      'realistic and professional',
      'subtle movements only',
      'high-quality rendering',
      'professional lighting',
      'news-appropriate content',
      'gentle motion'
    ];

    const subtleCameraKeywords = {
      'emotional': 'gentle close-up with minimal camera movement',
      'action': 'slow, steady camera movement following the subject',
      'landscape': 'very slow establishing shot with minimal pan',
      'dialogue': 'static shot with subtle focus changes',
      'standard': 'gentle, minimal camera movement'
    };

    let enhanced = basePrompt;
    enhanced += `, ${realisticNewsKeywords.join(', ')}`;
    
    if (sceneContext.mood) {
      enhanced += `, professional ${sceneContext.mood} mood`;
    }
    
    if (sceneContext.sceneType && subtleCameraKeywords[sceneContext.sceneType]) {
      enhanced += `, ${subtleCameraKeywords[sceneContext.sceneType]}`;
    }

    enhanced += ', extremely subtle and slow movements to prevent distortion';

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

  // Content Safety Filter (unchanged)
  sanitizeSceneForContentPolicy(sceneDescription, sceneType) {
    const sensitiveKeywords = {
      'bomb': 'aftermath with debris and emergency response',
      'explosion': 'aftermath scene with smoke and debris',
      'shooting': 'emergency response and investigation scene',
      'attack': 'aftermath with emergency services responding',
      'terrorist': 'security and investigation response',
      'violence': 'aftermath and community response',
      'weapon': 'security investigation and evidence collection',
      'murder': 'investigation scene with police presence',
      'killed': 'memorial and community response',
      'death': 'memorial service and community gathering',
      'crash': 'aftermath scene with emergency responders',
      'accident': 'emergency response and investigation',
      'fire': 'firefighters responding and aftermath cleanup',
      'disaster': 'rescue operations and community support',
      'riot': 'peaceful community dialogue and cleanup efforts',
      'protest': 'peaceful demonstration and community voices',
      'clash': 'community leaders discussing solutions',
      'pandemic': 'healthcare workers and community support',
      'outbreak': 'medical professionals and prevention measures',
      'emergency': 'first responders and community assistance'
    };

    let sanitizedDescription = sceneDescription.toLowerCase();
    let wasModified = false;

    for (const [sensitiveWord, safeAlternative] of Object.entries(sensitiveKeywords)) {
      const regex = new RegExp(`\\b${sensitiveWord}\\b`, 'gi');
      if (regex.test(sanitizedDescription)) {
        sanitizedDescription = sanitizedDescription.replace(regex, safeAlternative);
        wasModified = true;
      }
    }

    if (wasModified) {
      sanitizedDescription = sanitizedDescription
        .replace(/\b(hitting|striking|fighting|attacking|destroying)\b/gi, 'showing')
        .replace(/\b(blood|gore|graphic)\b/gi, 'evidence')
        .replace(/\b(screaming|crying|pain)\b/gi, 'emotional response')
        .replace(/\b(injured|wounded|hurt)\b/gi, 'receiving medical care');
    }

    if (wasModified) {
      console.log(`🛡️ Scene content sanitized for content policy compliance`);
    }

    return {
      sanitizedDescription,
      wasModified
    };
  }

  // Helper methods (unchanged)
  async generateImage(prompt) {
    try {
      const response = await this.openai.images.generate({
        model: 'gpt-image-1',
        prompt: prompt,
        size: '1536x1024',
        quality: 'high',
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
        quality: 'high'
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
      console.log('🎬 Starting country-aware Disney animation generation pipeline...');
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

      // Phase 3: Scene Generation with Country Context
      console.log('\n🖼️ Phase 3: Generating country-authentic scene images...');
      const sceneImages = await this.generateSceneImages(storyData.scenes, characterAssets, storyData.countryContext);
      console.log(`✅ Generated ${sceneImages.length} ${storyData.countryContext.primaryCountry}-authentic scene images`);

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

      console.log(`\n🎉 Country-aware animation generation completed successfully!`);
      console.log(`🌍 Generated for: ${storyData.countryContext.primaryCountry}${storyData.countryContext.primaryCity ? ` (${storyData.countryContext.primaryCity})` : ''}`);
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