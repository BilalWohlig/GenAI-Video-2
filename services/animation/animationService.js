// services/animation/animationService.js - Enhanced with comprehensive mood integration
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
  sceneType: z.enum(['action', 'dialogue', 'landscape', 'emotional', 'standard']),
  moodIntensity: z.number().min(1).max(10),
  emotionalTone: z.string()
});

const StoryStructureSchema = z.object({
  title: z.string(),
  theme: z.string(),
  characters: z.array(CharacterSchema),
  scenes: z.array(SceneSchema),
  overallMood: z.string(),
  moodProgression: z.array(z.string())
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

    // Define comprehensive mood configurations for every aspect of generation
    this.moodConfigurations = {
      'serious': {
        lighting: {
          colorTemp: '4200K neutral with slightly cooler undertones',
          shadows: 'defined shadows with controlled contrast, professional depth',
          atmosphere: 'focused, authoritative atmosphere with clear, direct lighting',
          intensity: 'moderate to high contrast maintaining clarity'
        },
        composition: {
          angles: 'eye-level or slightly low angle shots conveying authority and respect',
          framing: 'structured, formal composition with balanced, symmetrical elements',
          colors: 'neutral tones with cooler color palette, blues and grays',
          depth: 'clear depth of field emphasizing subject importance'
        },
        motion: {
          pace: 'deliberate, measured movements with purpose',
          camera: 'steady, stable camera work with minimal, controlled movement',
          character: 'purposeful gestures, formal posture, professional demeanor',
          transitions: 'smooth, professional transitions without abrupt changes'
        },
        keywords: ['professional', 'focused', 'authoritative', 'formal', 'measured', 'respectful', 'dignified'],
        voice: {
          tone: 'clear, professional, authoritative but respectful',
          pace: 'measured and deliberate',
          emphasis: 'factual delivery with appropriate gravity'
        }
      },
      'hopeful': {
        lighting: {
          colorTemp: '5600K warm daylight with golden undertones',
          shadows: 'soft, gentle shadows with warm fill light creating optimism',
          atmosphere: 'bright, optimistic lighting with warm, uplifting glow',
          intensity: 'well-lit scenes with positive energy and warmth'
        },
        composition: {
          angles: 'slightly elevated angles suggesting positivity and forward movement',
          framing: 'open, spacious composition with breathing room and expansion',
          colors: 'warm palette with golden, orange, and soft yellow tones',
          depth: 'expansive depth of field showing broader, positive context'
        },
        motion: {
          pace: 'smooth, flowing movements with gentle energy',
          camera: 'gentle upward camera movements, slow pushes creating optimism',
          character: 'open gestures, upright posture, genuine smiles, positive energy',
          transitions: 'smooth, uplifting transitions with gentle momentum'
        },
        keywords: ['optimistic', 'bright', 'uplifting', 'warm', 'encouraging', 'positive', 'inspiring'],
        voice: {
          tone: 'warm, encouraging, optimistic with genuine positivity',
          pace: 'steady with uplifting inflection',
          emphasis: 'highlighting positive outcomes and progress'
        }
      },
      'concerned': {
        lighting: {
          colorTemp: '3800K slightly cool with muted warmth',
          shadows: 'subtle shadows creating depth without harshness or drama',
          atmosphere: 'thoughtful, contemplative lighting with gentle, respectful contrast',
          intensity: 'moderate lighting creating appropriate solemnity'
        },
        composition: {
          angles: 'eye-level shots maintaining dignity and respect for subjects',
          framing: 'intimate, focused composition showing care and attention',
          colors: 'muted palette with subtle blue undertones, thoughtful grays',
          depth: 'controlled depth emphasizing emotional connection'
        },
        motion: {
          pace: 'careful, thoughtful movements showing consideration',
          camera: 'slow, deliberate camera movements with respectful distance',
          character: 'contemplative gestures, attentive posture, caring expressions',
          transitions: 'gentle, respectful transitions maintaining emotional tone'
        },
        keywords: ['thoughtful', 'contemplative', 'careful', 'attentive', 'respectful', 'considerate', 'empathetic'],
        voice: {
          tone: 'caring, thoughtful, with appropriate concern',
          pace: 'measured and considerate',
          emphasis: 'expressing genuine care and understanding'
        }
      },
      'urgent': {
        lighting: {
          colorTemp: '4500K bright, clear lighting with energy',
          shadows: 'defined shadows creating dynamic contrast and movement',
          atmosphere: 'energetic lighting with higher contrast and clarity',
          intensity: 'bright, alert lighting conveying importance'
        },
        composition: {
          angles: 'dynamic angles with energy while maintaining professionalism',
          framing: 'focused framing creating attention and importance',
          colors: 'vibrant but controlled palette with alert tones',
          depth: 'sharp depth of field drawing immediate attention'
        },
        motion: {
          pace: 'purposeful, efficient movements with controlled energy',
          camera: 'steady but energetic camera work with focus',
          character: 'alert posture, focused gestures, professional urgency',
          transitions: 'crisp, efficient transitions maintaining momentum'
        },
        keywords: ['important', 'focused', 'alert', 'efficient', 'purposeful', 'timely', 'professional'],
        voice: {
          tone: 'clear, direct, conveying importance without alarm',
          pace: 'slightly faster but controlled',
          emphasis: 'highlighting key information and timely aspects'
        }
      },
      'informative': {
        lighting: {
          colorTemp: '5000K neutral, clear lighting optimized for information delivery',
          shadows: 'minimal shadows for clarity, even illumination',
          atmosphere: 'clean, professional lighting enhancing comprehension',
          intensity: 'consistent, bright lighting for optimal visibility'
        },
        composition: {
          angles: 'straightforward, clear angles optimizing information presentation',
          framing: 'balanced composition supporting clear communication',
          colors: 'neutral, professional palette supporting content focus',
          depth: 'appropriate depth maintaining subject clarity'
        },
        motion: {
          pace: 'steady, clear movements supporting information delivery',
          camera: 'stable, professional camera work enhancing comprehension',
          character: 'clear, professional gestures and posture',
          transitions: 'smooth, professional transitions maintaining flow'
        },
        keywords: ['clear', 'professional', 'informative', 'educational', 'accessible', 'comprehensive'],
        voice: {
          tone: 'clear, professional, educational',
          pace: 'steady and comprehensible',
          emphasis: 'highlighting key information and facts'
        }
      },
      'celebratory': {
        lighting: {
          colorTemp: '5800K bright, joyful lighting with warm highlights',
          shadows: 'soft shadows with abundant light creating joy',
          atmosphere: 'festive, bright lighting with positive energy',
          intensity: 'abundant, joyful lighting creating celebration'
        },
        composition: {
          angles: 'uplifting angles celebrating positive moments',
          framing: 'open, expansive composition showing celebration',
          colors: 'vibrant, joyful palette with warm, celebratory tones',
          depth: 'inclusive depth of field showing community and togetherness'
        },
        motion: {
          pace: 'joyful, energetic movements with positive momentum',
          camera: 'celebratory camera movements with gentle energy',
          character: 'joyful expressions, celebratory gestures, positive energy',
          transitions: 'uplifting transitions with celebratory feel'
        },
        keywords: ['joyful', 'celebratory', 'positive', 'energetic', 'uplifting', 'festive', 'triumphant'],
        voice: {
          tone: 'joyful, celebratory, with genuine happiness',
          pace: 'energetic and uplifting',
          emphasis: 'highlighting achievements and positive outcomes'
        }
      },
      'reflective': {
        lighting: {
          colorTemp: '3200K warm, contemplative lighting',
          shadows: 'gentle, thoughtful shadows creating depth and contemplation',
          atmosphere: 'warm, introspective lighting encouraging reflection',
          intensity: 'moderate, thoughtful lighting creating contemplative mood'
        },
        composition: {
          angles: 'thoughtful angles encouraging contemplation',
          framing: 'intimate composition supporting reflection',
          colors: 'warm, muted palette encouraging introspection',
          depth: 'contemplative depth creating thoughtful atmosphere'
        },
        motion: {
          pace: 'slow, contemplative movements encouraging thought',
          camera: 'gentle, reflective camera work',
          character: 'thoughtful expressions, contemplative posture',
          transitions: 'gentle, reflective transitions maintaining contemplative mood'
        },
        keywords: ['contemplative', 'thoughtful', 'introspective', 'reflective', 'peaceful', 'meditative'],
        voice: {
          tone: 'thoughtful, reflective, with gentle wisdom',
          pace: 'slow and contemplative',
          emphasis: 'encouraging reflection and understanding'
        }
      },
      'professional': {
        lighting: {
          colorTemp: '4800K clean, professional lighting',
          shadows: 'controlled shadows maintaining professionalism',
          atmosphere: 'business-appropriate lighting conveying competence',
          intensity: 'appropriate professional lighting standards'
        },
        composition: {
          angles: 'professional angles conveying competence and reliability',
          framing: 'business-appropriate composition maintaining professionalism',
          colors: 'professional palette with business-appropriate tones',
          depth: 'professional depth maintaining subject focus'
        },
        motion: {
          pace: 'professional, competent movements',
          camera: 'business-standard camera work',
          character: 'professional demeanor, competent posture',
          transitions: 'professional transitions maintaining business standards'
        },
        keywords: ['competent', 'reliable', 'professional', 'business-appropriate', 'skilled', 'experienced'],
        voice: {
          tone: 'professional, competent, reliable',
          pace: 'business-appropriate and clear',
          emphasis: 'highlighting expertise and competence'
        }
      }
    };
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

  // NEW METHOD: Get mood configuration
  getMoodConfiguration(mood) {
    const normalizedMood = mood.toLowerCase();
    
    // Direct match
    if (this.moodConfigurations[normalizedMood]) {
      return this.moodConfigurations[normalizedMood];
    }
    
    // Partial matches and synonyms
    const moodMappings = {
      'grave': 'serious',
      'somber': 'serious',
      'formal': 'serious',
      'positive': 'hopeful',
      'optimistic': 'hopeful',
      'upbeat': 'celebratory',
      'worried': 'concerned',
      'anxious': 'concerned',
      'troubled': 'concerned',
      'critical': 'urgent',
      'important': 'urgent',
      'emergency': 'urgent',
      'educational': 'informative',
      'explanatory': 'informative',
      'factual': 'informative',
      'joyful': 'celebratory',
      'happy': 'celebratory',
      'triumphant': 'celebratory',
      'thoughtful': 'reflective',
      'contemplative': 'reflective',
      'business': 'professional',
      'corporate': 'professional'
    };
    
    for (const [synonym, baseMood] of Object.entries(moodMappings)) {
      if (normalizedMood.includes(synonym)) {
        return this.moodConfigurations[baseMood];
      }
    }
    
    // Default to professional if no match found
    console.log(`⚠️ Unknown mood '${mood}', defaulting to 'professional'`);
    return this.moodConfigurations['professional'];
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

  // UPDATED: Phase 1: Story Development with Enhanced Mood Integration
  async generateStoryStructure(article, sceneCount) {
    // First, detect the country context
    const countryContext = await this.detectCountryContext(article);

    const systemPrompt = `You are a professional news animator who creates Disney/Pixar-style 3D animated news stories with sophisticated mood and emotional progression. Your job is to transform real news articles into visually appealing animated content while maintaining journalistic accuracy and creating appropriate emotional resonance through carefully crafted mood progression.

    CRITICAL MOOD REQUIREMENTS:
    - Each scene must have a specific mood that matches the content and emotional progression
    - Mood intensity should be rated 1-10 (1=very subtle, 10=very intense)
    - Provide emotional tone that guides the visual and audio treatment
    - Create mood progression that flows naturally through the story
    - Consider cultural appropriateness for ${countryContext.primaryCountry}

    AVAILABLE MOODS: serious, hopeful, concerned, urgent, informative, celebratory, reflective, professional

    CRITICAL: When real public figures are mentioned in the article (politicians, celebrities, business leaders, etc.), you MUST include their actual names in the character descriptions.

    COUNTRY & CULTURAL CONTEXT: This story takes place primarily in ${countryContext.primaryCountry}${countryContext.primaryCity ? ` (${countryContext.primaryCity})` : ''}. Ensure all locations, general public characters, and cultural elements are authentic to this region.`;
    
    const userPrompt = `Transform this news article into a realistic Disney/Pixar-style 3D animated news story with exactly ${sceneCount} scenes, with sophisticated mood progression and emotional depth.

    Article: ${article}

    ENHANCED MOOD REQUIREMENTS:
    🎭 MOOD SPECIFICATION FOR EACH SCENE:
    - Choose the most appropriate mood from: serious, hopeful, concerned, urgent, informative, celebratory, reflective, professional
    - Provide moodIntensity (1-10 scale) based on content severity and emotional impact
    - Specify emotionalTone (e.g., "respectfully concerned", "cautiously optimistic", "professionally urgent")
    - Consider mood progression across scenes for emotional storytelling flow
    - Ensure mood matches both content and cultural context of ${countryContext.primaryCountry}

    MOOD PROGRESSION GUIDELINES:
    📈 Create emotional arc through scenes:
    - Opening: Establish context with appropriate introductory mood
    - Development: Show progression through events with mood evolution
    - Resolution: Conclude with mood that reflects outcomes and future implications
    - Maintain cultural sensitivity for ${countryContext.primaryCountry} audience

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

    CHARACTER NAMING GUIDELINES:
    **CRITICAL**: If the article mentions real public figures by name, you MUST include their actual names in character descriptions.

    **CHARACTER APPEARANCE GUIDELINES - VERY IMPORTANT**:
    - Characters must be described WITHOUT any objects, artifacts, or items in their hands
    - NO microphones, phones, documents, papers, tools, or any handheld items
    - Characters should have EMPTY HANDS or hands at their sides
    - Focus only on their physical appearance, clothing, and facial features
    - This ensures clean character references that work across all scenes
    
    Create:
    - Realistic character descriptions with ACTUAL NAMES when public figures are mentioned
    - **Characters MUST have empty hands and no artifacts/objects**
    - Factual scene descriptions based on actual events in the article
    - DETAILED MOOD SPECIFICATIONS for each scene including mood type, intensity, and emotional tone
    - Professional, news-appropriate narration that matches the specified mood
    - Scene types optimized for the specified mood and emotional progression
    - Each scene should be 10 seconds duration for clarity, but for narration text, it should be as if each respective clip is 6-8s long
    - Overall mood progression that creates compelling emotional storytelling while remaining factual`;

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
      
      // Enhance character descriptions with names
      for(const character of storyData.characters) {
        if (character.name && character.description) {
          character.description = `${character.name} - ${character.description}`;
        }
      }

      // Validate and enhance mood data for each scene
      storyData.scenes = storyData.scenes.map(scene => ({
        ...scene,
        moodIntensity: scene.moodIntensity || 5,
        emotionalTone: scene.emotionalTone || scene.mood,
        moodConfig: this.getMoodConfiguration(scene.mood)
      }));
      
      console.log("Enhanced StoryData with Moods:");
      console.log("Characters:", storyData.characters);
      console.log("Scenes with Moods:", storyData.scenes.map(s => ({
        number: s.sceneNumber,
        mood: s.mood,
        intensity: s.moodIntensity,
        tone: s.emotionalTone
      })));
      
      console.log(`✅ Country-aware news story with mood progression generated: "${storyData.title}"`);
      console.log(`🌍 Tailored for: ${countryContext.primaryCountry}${countryContext.primaryCity ? ` (${countryContext.primaryCity})` : ''}`);
      console.log(`🎭 Mood progression: ${storyData.scenes.map(s => s.mood).join(' → ')}`);

      console.log("Scenes", storyData.scenes)
      
      return storyData;
    } catch (error) {
      console.error('Error generating story structure:', error);
      throw new Error('Failed to generate story structure');
    }
  }

  // UPDATED: Phase 2: Character Generation with Mood Awareness
  async generateCharacterAssets(characters, countryContext) {
    const characterAssets = {};

    for (const character of characters) {
      try {
        console.log(`🎭 Generating mood-aware character: ${character.name}`);

        // Generate master character image with mood-neutral base
        const masterCharacterPrompt = `
        Create a Disney/Pixar style 3D character: ${character.description}. 
        ${character.personality}. 
        
        COUNTRY CONTEXT: This character is in ${countryContext.primaryCountry}. Ensure authenticity:
        - Appearance should reflect ${countryContext.demographicNotes}
        - Clothing style appropriate for ${countryContext.primaryCountry} professional/cultural standards
        - Facial features representative of ${countryContext.primaryCountry} population (if applicable)
        - Cultural authenticity in overall presentation
        
        MOOD-NEUTRAL BASE CHARACTER REQUIREMENTS:
        - Neutral, professional expression that can be adapted for different moods
        - Front view, balanced expression, clean white background
        - High quality 3D rendering, professional Disney/Pixar animation style
        - Vibrant colors, appealing character design suitable for mood variations
        - HANDS MUST BE EMPTY - no objects, artifacts, or items in hands
        - Hands should be at sides or in relaxed position
        - NO microphones, phones, documents, tools, or any handheld items
        - Focus on facial features, clothing, and overall appearance only
        - Clean, uncluttered character reference suitable for all mood-based scenes
        - Authentic to ${countryContext.primaryCountry} cultural context
        - Expression should be adaptable for various moods (serious, hopeful, concerned, etc.)`;

        const masterImagePath = await this.generateImage(masterCharacterPrompt);
        
        // Generate character expressions for different moods
        // const moodExpressions = ['serious', 'hopeful', 'concerned', 'professional', 'focused'];
        const moodExpressions = [];
        const characterExpressions = {};
        
        for (const moodExpression of moodExpressions) {
          const moodConfig = this.getMoodConfiguration(moodExpression);
          
          const expressionPrompt = `
            Change the character's expression to convey ${moodExpression} mood while maintaining the exact same character design, 
            style, colors, and physical appearance. Same Disney/Pixar 3D animation style, 
            front view, white background. Keep all character features identical except the facial expression.
            
            MOOD-SPECIFIC EXPRESSION REQUIREMENTS for ${moodExpression}:
            - Facial expression should convey: ${moodConfig.keywords.join(', ')}
            - Expression should be ${moodExpression} but professional and appropriate
            - Maintain cultural authenticity for ${countryContext.primaryCountry}
            - Eye expression, eyebrow position, and mouth should reflect ${moodExpression} mood
            - Overall demeanor should be ${moodExpression} yet dignified
            
            CRITICAL: Keep hands EMPTY and free of any objects, artifacts, or items - exactly like the reference image.
            Maintain the same hand positioning and ensure no objects appear in the hands.`;  
          
          const expressionImagePath = await this.generateImageWithReference(
            [masterImagePath], 
            expressionPrompt
          );
          characterExpressions[moodExpression] = expressionImagePath;
        }

        characterAssets[character.name] = {
          master: masterImagePath,
          expressions: characterExpressions,
          description: character.description,
          countryContext: countryContext,
          moodCapable: true
        };

        // Copy to permanent character directory
        const permanentPath = path.join(this.workingDir, 'characters', `${character.name}_master.png`);
        await fs.copyFile(masterImagePath, permanentPath);
        
        console.log(`✅ Generated ${countryContext.primaryCountry}-appropriate mood-capable character ${character.name} with ${moodExpressions.length} mood expressions`);
        
      } catch (error) {
        console.error(`Error generating character ${character.name}:`, error);
        throw new Error(`Failed to generate character: ${character.name}`);
      }
    }

    return characterAssets;
  }

  // UPDATED: Phase 3: Enhanced Scene Generation with Comprehensive Mood Integration
  async generateSceneImages(scenes, characterAssets, countryContext) {
    const sceneImages = [];

    for (const scene of scenes) {
      try {
        console.log(`🎬 Generating mood-enhanced scene ${scene.sceneNumber} (${scene.mood}, intensity: ${scene.moodIntensity}): ${scene.description.substring(0, 50)}...`);

        // Get mood configuration for this scene
        const moodConfig = this.getMoodConfiguration(scene.mood);
        console.log(`🎭 Applying ${scene.mood} mood with ${moodConfig.keywords.join(', ')} characteristics`);

        // Apply content safety filter with mood awareness
        const { sanitizedDescription, wasModified } = this.sanitizeSceneForContentPolicy(scene.description, scene.sceneType);

        // Collect reference images for characters in this scene, choosing mood-appropriate expressions
        const referenceImages = [];
        let enhancedPrompt = sanitizedDescription;

        // Build detailed character positioning and actions with mood
        let characterDetails = "";
        if (scene.characters && scene.characters.length > 0) {
          // Build character reference mapping with mood-appropriate expressions
          let characterReferences = [];
          
          scene.characters.forEach((charName, index) => {
            if (characterAssets[charName]) {
              // Choose mood-appropriate character expression
              let characterImagePath = characterAssets[charName].master;
              
              if (characterAssets[charName].expressions && characterAssets[charName].expressions[scene.mood]) {
                characterImagePath = characterAssets[charName].expressions[scene.mood];
                console.log(`   Using ${scene.mood} expression for ${charName}`);
              } else if (characterAssets[charName].expressions && characterAssets[charName].expressions['professional']) {
                characterImagePath = characterAssets[charName].expressions['professional'];
                console.log(`   Using professional expression for ${charName} (${scene.mood} not available)`);
              }
              
              referenceImages.push(characterImagePath);
              characterReferences.push(`${charName}(image ${index + 1})`);
              
              // Add detailed character positioning based on scene type and mood
              characterDetails += this.generateMoodAwareCharacterDescription(charName, index + 1, scene, countryContext, moodConfig);
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

        // Generate mood-enhanced environmental description
        const environmentalDetails = this.generateMoodAwareEnvironmentalDescription(scene, countryContext, moodConfig);
        
        // Generate mood-enhanced lighting and mood specifications
        const lightingDetails = this.generateMoodAwareLightingDescription(scene, countryContext, moodConfig);
        
        // Generate mood-enhanced composition and camera specifications
        const compositionDetails = this.generateMoodAwareCompositionDescription(scene, countryContext, moodConfig);

        // Build complete mood-enhanced scene prompt
        let fullScenePrompt = `
        MOOD-ENHANCED Disney/Pixar 3D animation scene with ${scene.mood.toUpperCase()} mood (intensity: ${scene.moodIntensity}/10): ${enhancedPrompt}
        
        SCENE SPECIFICATIONS:
        Primary Location: ${scene.location}
        Scene Mood: ${scene.mood} (${scene.emotionalTone})
        Mood Intensity: ${scene.moodIntensity}/10
        Camera Position: ${scene.cameraAngle}
        
        MOOD-SPECIFIC VISUAL TREATMENT:
        Mood Keywords: ${moodConfig.keywords.join(', ')}
        Emotional Tone: ${scene.emotionalTone}
        Visual Style: ${scene.mood} mood with Disney/Pixar quality rendering
        
        DETAILED CHARACTER POSITIONING & MOOD ACTIONS:
        ${characterDetails}
        
        MOOD-ENHANCED ENVIRONMENTAL DESCRIPTION:
        ${environmentalDetails}
        
        MOOD-ENHANCED LIGHTING & ATMOSPHERE:
        ${lightingDetails}
        
        MOOD-ENHANCED COMPOSITION & FRAMING:
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
        - Prioritize clean, uncluttered visual composition matching ${scene.mood} mood
        - Text should blend into the background as environmental detail
        
        TECHNICAL RENDERING SPECIFICATIONS:
        - Ultra-high quality Disney/Pixar 3D rendering optimized for ${scene.mood} mood
        - Professional cinematic lighting matching ${scene.mood} mood requirements
        - Photorealistic materials and textures with ${scene.mood} mood enhancement
        - Advanced depth of field and bokeh effects supporting ${scene.mood} mood
        - Color grading specifically calibrated for ${scene.mood} mood (intensity: ${scene.moodIntensity}/10)
        - Sharp focus on main subjects with ${scene.mood} mood-appropriate background treatment
        - Film-quality composition and framing supporting ${scene.mood} emotional tone
        - Professional broadcast-ready visual quality with ${scene.mood} mood consistency
        
        CULTURAL AUTHENTICITY REQUIREMENTS:
        - Buildings and infrastructure must match ${countryContext.architecturalStyle}
        - Street scenes include typical ${countryContext.primaryCountry} elements (vehicles, street furniture, signage styles)
        - Background characters reflect authentic local demographics: ${countryContext.demographicNotes}
        - Environmental details culturally accurate for ${countryContext.primaryCountry}
        - Weather and lighting appropriate for the geographical region and ${scene.mood} mood
        - Local architectural details and urban planning styles
        - Authentic vehicle models and license plate styles for the region
        - Appropriate flora and landscape elements for the climate
        
        CONTENT SAFETY & PROFESSIONALISM:
        - Maintain REALISTIC and NEWS-APPROPRIATE content with ${scene.mood} mood treatment
        - Focus on aftermath, response, and community impact rather than violent actions
        - Show professional emergency responders, investigators, and community support
        - Avoid graphic content, violence, or disturbing imagery while maintaining ${scene.mood} mood authenticity
        - Family-friendly presentation suitable for broadcast news with appropriate ${scene.mood} mood
        - No weapons, blood, or explicit violence - emphasize response and recovery with ${scene.mood} mood
        - Highlight human resilience, community support, and professional response
        - Clean visual environment without distracting textual elements, optimized for ${scene.mood} mood
        
        CHARACTER CONSISTENCY REQUIREMENTS:
        - Maintain exact character designs, colors, and physical features from reference images
        - Apply ${scene.mood} mood-appropriate expressions and body language
        - Keep consistent facial features, hair, clothing, and body proportions
        - Ensure professional, realistic appearance appropriate for ${countryContext.primaryCountry} context
        - Characters should maintain their established visual identity with ${scene.mood} mood adaptation
        - Preserve character personality through ${scene.mood} mood-enhanced body language and positioning
        
        FINAL QUALITY STANDARDS:
        - No magical elements, fantasy creatures, or fictional aspects
        - Professional, real-world setting appropriate for news content with ${scene.mood} mood enhancement
        - Modern, contemporary ${countryContext.primaryCountry} environments
        - Maintain journalistic accuracy and cultural authenticity
        - Minimize readable text to maintain focus on visual narrative
        - Achieve broadcast-quality, professional animation standards with sophisticated ${scene.mood} mood implementation
        - Mood intensity of ${scene.moodIntensity}/10 should be clearly evident in lighting, color, and atmosphere`;

        let sceneImagePath;

        if (referenceImages.length > 0) {
          // Generate scene with character references and mood-enhanced descriptions
          console.log(`   Using ${referenceImages.length} mood-appropriate character reference images for ${scene.mood} scene`);
        //   console.log("Full Scene Prompt ", fullScenePrompt)
          sceneImagePath = await this.generateImageWithReference(referenceImages, fullScenePrompt);
        } else {
          // Generate scene without character references but with mood enhancement
          console.log(`   Generating ${scene.mood} mood scene without character references`);
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
          mood: scene.mood,
          moodIntensity: scene.moodIntensity,
          emotionalTone: scene.emotionalTone,
          moodConfig: moodConfig,
          detailedPromptUsed: true,
          moodEnhanced: true
        });

        // Copy to permanent scene directory
        const permanentPath = path.join(this.workingDir, 'scenes', `scene_${scene.sceneNumber}_${scene.mood}.png`);
        await fs.copyFile(sceneImagePath, permanentPath);

        if (wasModified) {
          console.log(`✅ Content-safe ${scene.mood} mood scene ${scene.sceneNumber} generated (content modified for safety)`);
        } else {
          console.log(`✅ ${scene.mood} mood scene ${scene.sceneNumber} generated with ${scene.characters?.length || 0} mood-appropriate character references`);
        }

      } catch (error) {
        console.error(`Error generating mood-enhanced scene ${scene.sceneNumber}:`, error);
        throw new Error(`Failed to generate mood-enhanced scene: ${scene.sceneNumber}`);
      }
    }

    return sceneImages;
  }

  // NEW: Generate mood-aware character descriptions
  generateMoodAwareCharacterDescription(charName, imageIndex, scene, countryContext, moodConfig) {
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

    return `
    CHARACTER ${imageIndex} - ${charName}(image ${imageIndex}) - ${scene.mood.toUpperCase()} MOOD:
    - POSITIONING: ${charPosition}
    - MOOD-SPECIFIC BODY LANGUAGE: ${this.getMoodBodyLanguage(scene.mood, moodConfig)}
    - FACIAL EXPRESSION: ${scene.mood} expression conveying ${scene.emotionalTone}
    - CULTURAL CONTEXT: Appearance and attire authentic to ${countryContext.primaryCountry} ${scene.mood} professional standards
    - CLOTHING: Appropriate for ${countryContext.primaryCountry} ${scene.mood} setting, matching local professional dress codes
    - MOOD INTENSITY: ${scene.moodIntensity}/10 intensity reflected in posture and expression
    - ACTIVITY: Engaged in ${scene.mood} ${scene.sceneType} coordination activities
    - LIGHTING: Character lit with ${moodConfig.lighting.atmosphere}
    - DEPTH: ${isPrimary ? 'Primary focus with sharp detail' : 'Secondary depth with background integration'}
    - CULTURAL DETAILS: Authentic ${countryContext.primaryCountry} demographic representation
    - MOOD KEYWORDS: Embodying ${moodConfig.keywords.join(', ')}
    `;
  }

  // NEW: Get mood-specific body language
  getMoodBodyLanguage(mood, moodConfig) {
    const bodyLanguageMap = {
      'serious': 'upright posture, hands at sides, formal stance, direct gaze, composed demeanor',
      'hopeful': 'open posture, slightly forward lean, gentle smile, optimistic stance',
      'concerned': 'attentive posture, slight forward lean, caring expression, engaged stance',
      'urgent': 'alert posture, focused stance, professional urgency, ready-for-action demeanor',
      'informative': 'professional posture, clear gesture positioning, educational stance',
      'celebratory': 'joyful posture, open gestures, celebratory stance, positive energy',
      'reflective': 'contemplative posture, thoughtful stance, introspective demeanor',
      'professional': 'business-appropriate posture, confident stance, competent demeanor'
    };

    return bodyLanguageMap[mood] || bodyLanguageMap['professional'];
  }

  // NEW: Generate mood-aware environmental descriptions
  generateMoodAwareEnvironmentalDescription(scene, countryContext, moodConfig) {
    const baseEnvironment = this.getLocationEnvironment(scene.location, countryContext);

    return `
    MOOD-ENHANCED ENVIRONMENTAL SPECIFICATIONS (${scene.mood.toUpperCase()}):
    - PRIMARY SETTING: ${baseEnvironment} enhanced with ${scene.mood} mood characteristics
    - MOOD-SPECIFIC LIGHTING: ${moodConfig.lighting.atmosphere}
    - COLOR PALETTE: ${moodConfig.composition.colors} reflecting ${scene.mood} mood
    - ARCHITECTURAL DETAILS: Beautiful ${countryContext.architecturalStyle} with ${scene.mood} mood-appropriate materials and design elements
    - MOOD-ENHANCED PROPS: 3-5 carefully placed environmental props that enhance the ${scene.mood} scene (${moodConfig.keywords.join(', ')} elements)
    - ATMOSPHERIC QUALITY: ${moodConfig.lighting.intensity} creating ${scene.mood} mood
    - CULTURAL AUTHENTICITY: All environmental elements reflect ${countryContext.primaryCountry} design standards with ${scene.mood} mood enhancement
    - MOOD AMBIANCE: Professional, ${scene.mood} environment appropriate for ${scene.emotionalTone}
    - DEPTH LAYERS: Foreground (${scene.mood} elements), middle ground (main ${scene.mood} area), background (supporting ${scene.mood} context)
    - MATERIAL QUALITY: Realistic textures and materials rendered with ${scene.mood} mood-appropriate lighting and color treatment
    - REGIONAL FLORA: If outdoor scene, include vegetation and landscape elements for ${countryContext.primaryCountry} climate with ${scene.mood} mood enhancement
    - ACTIVITY CONTEXT: All environmental elements suggest ${scene.mood} ${scene.sceneType} activities
    `;
  }

  // NEW: Generate mood-aware lighting descriptions
  generateMoodAwareLightingDescription(scene, countryContext, moodConfig) {
    const timeOfDay = this.determineTimeOfDay(scene);
    const weatherConditions = this.determineWeatherConditions(scene, countryContext);

    return `
    MOOD-ENHANCED LIGHTING & ATMOSPHERE (${scene.mood.toUpperCase()}):
    - PRIMARY LIGHTING: ${moodConfig.lighting.atmosphere} with ${moodConfig.lighting.colorTemp}
    - MOOD-SPECIFIC SHADOWS: ${moodConfig.lighting.shadows}
    - INTENSITY LEVEL: ${moodConfig.lighting.intensity} (${scene.moodIntensity}/10 mood intensity)
    - TIME OF DAY: ${timeOfDay.description} with ${scene.mood} mood-appropriate natural lighting
    - WEATHER: ${weatherConditions.description} affecting ${scene.mood} ambient lighting
    - COLOR TEMPERATURE: ${moodConfig.lighting.colorTemp} maintaining ${scene.mood} mood authenticity
    - SHADOW QUALITY: ${moodConfig.lighting.shadows} supporting ${scene.mood} emotional tone
    - AMBIENT OCCLUSION: Subtle environmental shadowing enhancing ${scene.mood} mood depth
    - REFLECTION QUALITY: Appropriate reflections with ${scene.mood} mood-enhanced lighting treatment
    - ATMOSPHERIC EFFECTS: ${weatherConditions.atmospherics} contributing to ${scene.mood} mood
    - CONTRAST RATIO: ${scene.mood} mood-appropriate contrast maintaining emotional impact
    - HIGHLIGHT MANAGEMENT: Controlled highlights supporting ${scene.mood} mood authenticity
    - BACKGROUND LIGHTING: Graduated lighting supporting ${scene.mood} mood depth perception
    - REGIONAL LIGHTING: Appropriate for ${countryContext.primaryCountry} with ${scene.mood} mood enhancement
    - MOOD ENHANCEMENT: Lighting specifically designed to create ${scene.mood} atmosphere with ${scene.emotionalTone}
    `;
  }

  // NEW: Generate mood-aware composition descriptions
  generateMoodAwareCompositionDescription(scene, countryContext, moodConfig) {
    const cameraAngles = {
      'close-up': 'framing focusing on character expressions and emotions',
      'medium shot': 'balanced composition showing characters from waist up',
      'wide shot': 'establishing composition showing full environment and character context',
      'over-the-shoulder': 'dynamic composition providing viewer perspective',
      'low angle': 'slight upward angle conveying authority and importance',
      'high angle': 'elevated perspective providing comprehensive view',
      'eye level': 'standard framing at natural eye level'
    };

    const angle = scene.cameraAngle.toLowerCase();
    let cameraSpec = cameraAngles['eye level']; // default
    
    Object.keys(cameraAngles).forEach(key => {
      if (angle.includes(key.replace('-', ' ')) || angle.includes(key.replace(' ', ''))) {
        cameraSpec = cameraAngles[key];
      }
    });

    return `
    MOOD-ENHANCED COMPOSITION & FRAMING (${scene.mood.toUpperCase()}):
    - CAMERA ANGLE: ${cameraSpec} optimized for ${scene.mood} mood expression
    - MOOD-SPECIFIC FRAMING: ${moodConfig.composition.angles}
    - COMPOSITION STYLE: ${moodConfig.composition.framing}
    - COLOR TREATMENT: ${moodConfig.composition.colors} palette supporting ${scene.mood} mood
    - DEPTH OF FIELD: ${moodConfig.composition.depth} based on ${scene.mood} mood requirements
    - ASPECT RATIO: 16:9 professional format optimized for ${scene.mood} mood presentation
    - RULE OF THIRDS: Strategic placement supporting ${scene.mood} emotional impact
    - LEADING LINES: Environmental elements guiding attention with ${scene.mood} mood support
    - VISUAL BALANCE: Harmonious distribution supporting ${scene.mood} mood (intensity: ${scene.moodIntensity}/10)
    - HEADROOM: Space above characters maintaining ${scene.mood} mood-appropriate framing
    - BREATHING ROOM: Adequate space promoting ${scene.mood} emotional energy
    - BACKGROUND INTEGRATION: Background elements supporting ${scene.mood} mood
    - CULTURAL FRAMING: Composition appropriate for ${countryContext.primaryCountry} with ${scene.mood} mood
    - MOVEMENT SPACE: Directional space for ${scene.mood} mood-appropriate movement
    - SYMMETRY/ASYMMETRY: Balanced approach appropriate for ${scene.mood} mood and ${scene.sceneType} content
    - FRAME STABILITY: Composition suitable for ${scene.mood} mood without distracting elements
    - VISUAL HIERARCHY: Clear elements guiding attention through ${scene.mood} mood experience
    - MOOD ENERGY: Composition specifically designed to convey ${scene.mood} atmosphere with ${scene.emotionalTone}
    `;
  }

  // Helper method to get base location environment
  getLocationEnvironment(location, countryContext) {
    const locationTypes = {
      'office': `Modern ${countryContext.primaryCountry} office environment with local architectural details`,
      'street': `${countryContext.primaryCountry} street scene with local architecture: ${countryContext.architecturalStyle}`,
      'government': `Professional ${countryContext.primaryCountry} government building with national architectural style`,
      'residential': `${countryContext.primaryCountry} residential area with local housing architecture`,
      'hospital': `Professional ${countryContext.primaryCountry} medical facility with modern healthcare environment`,
      'school': `Educational facility in ${countryContext.primaryCountry} with local school architecture`
    };

    // Determine location type from scene location
    let locationType = 'office'; // default
    const locationLower = location.toLowerCase();
    if (locationLower.includes('street') || locationLower.includes('road') || locationLower.includes('plaza')) locationType = 'street';
    else if (locationLower.includes('government') || locationLower.includes('capitol') || locationLower.includes('ministry')) locationType = 'government';
    else if (locationLower.includes('home') || locationLower.includes('house') || locationLower.includes('residential')) locationType = 'residential';
    else if (locationLower.includes('hospital') || locationLower.includes('medical') || locationLower.includes('clinic')) locationType = 'hospital';
    else if (locationLower.includes('school') || locationLower.includes('university') || locationLower.includes('campus')) locationType = 'school';

    return locationTypes[locationType] || locationTypes['office'];
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
    } else if (description.includes('sun') || description.includes('bright') || mood.includes('hopeful') || mood.includes('celebratory')) {
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

  // UPDATED: Phase 4: Video Generation with Enhanced Mood Integration
  async generateSceneVideos(sceneImages) {
    const sceneVideos = [];

    for (const scene of sceneImages) {
      try {
        console.log(`🎥 Generating ${scene.mood} mood video for scene ${scene.sceneNumber} (intensity: ${scene.moodIntensity}/10)`);

        // Get mood configuration for enhanced motion generation
        const moodConfig = scene.moodConfig || this.getMoodConfiguration(scene.mood);

        // Generate motion description using GPT-4 with enhanced mood integration
        const motionSystemPrompt = `You are a professional Disney animation director specializing in mood-based motion design. Create motion descriptions that perfectly capture specific moods while maintaining family-friendly, professional content suitable for news animation. Focus on how camera movement, character motion, and environmental elements should move to convey the exact mood specified.

        MOOD EXPERTISE: You understand how different moods require different motion approaches:
        - SERIOUS: Steady, measured movements conveying authority and importance
        - HOPEFUL: Gentle, uplifting movements with positive energy
        - CONCERNED: Careful, thoughtful movements showing consideration
        - URGENT: Focused, efficient movements without chaos or alarm
        - INFORMATIVE: Clear, stable movements supporting comprehension
        - CELEBRATORY: Joyful, energetic movements with positive momentum
        - REFLECTIVE: Slow, contemplative movements encouraging thought
        - PROFESSIONAL: Competent, reliable movements maintaining business standards`;
        
        const motionUserPrompt = `Create mood-specific motion for this ${scene.mood.toUpperCase()} scene (intensity: ${scene.moodIntensity}/10):
        ${scene.description}
        
        MOOD-SPECIFIC MOTION REQUIREMENTS for ${scene.mood}:
        - Mood Character: ${moodConfig.keywords.join(', ')}
        - Motion Style: ${moodConfig.motion.pace}
        - Camera Work: ${moodConfig.motion.camera}
        - Character Movement: ${moodConfig.motion.character}
        - Transitions: ${moodConfig.motion.transitions}
        - Intensity Level: ${scene.moodIntensity}/10 (adjust motion intensity accordingly)
        - Emotional Tone: ${scene.emotionalTone}
        
        SCENE CONTEXT:
        - Scene type: ${scene.sceneType}
        - Scene duration: ${scene.duration} seconds
        - Cultural context: Appropriate for professional news content
        
        FAMILY-FRIENDLY REQUIREMENTS:
        - Focus ONLY on positive coordination, planning, and community cooperation
        - Show professional collaboration and constructive teamwork
        - Emphasize helpful assistance and positive civic engagement
        - All activities should appear constructive and supportive
        - Present all interactions as positive professional coordination
        - Focus on community support and collaborative problem-solving
        
        MOOD-APPROPRIATE MOVEMENT GUIDELINES:
        For ${scene.mood} mood specifically:
        ${this.getMoodSpecificMotionGuidelines(scene.mood, scene.moodIntensity)}
        
        Provide a mood-appropriate motion description (max 150 characters) that perfectly captures ${scene.mood} mood with ${scene.moodIntensity}/10 intensity while maintaining professional, family-friendly content.`;

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

        // Enhance prompt for mood-specific Disney quality
        const enhancedPrompt = this.enhancePromptForMoodSpecificDisney(motionDescription, scene, moodConfig);

        // Convert local image file to a format APIs can use
        const imageUrl = await this.convertLocalImageForKlingAI(scene.image);

        // Generate video using Kling AI with mood-specific settings
        const result = await KlingAI.generateVideoWithFallback(
          imageUrl,
          enhancedPrompt,
          scene.duration,
          scene.sceneType,
          scene.mood,
          scene.moodIntensity
        );

        // Download video locally
        const videoPath = path.join(this.workingDir, 'videos', `scene_${scene.sceneNumber}_${scene.mood}_${uuidv4()}.mp4`);
        await KlingAI.downloadVideo(result.videoUrl, videoPath);
        
        sceneVideos.push({
          sceneNumber: scene.sceneNumber,
          videoPath: videoPath,
          narration: scene.narration,
          duration: scene.duration,
          klingTaskId: result.taskId,
          mood: scene.mood,
          moodIntensity: scene.moodIntensity,
          emotionalTone: scene.emotionalTone
        });

        console.log(`✅ ${scene.mood} mood scene ${scene.sceneNumber} video generated successfully (intensity: ${scene.moodIntensity}/10)`);

      } catch (error) {
        console.error(`Error generating ${scene.mood} mood video for scene ${scene.sceneNumber}:`, error);
        throw new Error(`Failed to generate mood-enhanced video for scene: ${scene.sceneNumber}`);
      }
    }

    return sceneVideos;
  }

  // NEW: Get mood-specific motion guidelines
  getMoodSpecificMotionGuidelines(mood, intensity) {
    const motionGuidelines = {
      'serious': `
        - Steady, controlled camera movements without sudden shifts
        - Characters move with purpose and dignity
        - Minimal but meaningful gestures
        - Camera holds steady on important moments
        - Transitions are smooth and measured
        - Intensity ${intensity}/10: ${intensity > 7 ? 'More formal, slower movements' : intensity > 4 ? 'Balanced, professional movements' : 'Gentle, respectful movements'}`,
      
      'hopeful': `
        - Gentle upward camera movements suggesting positivity
        - Characters have open, welcoming body language
        - Smooth, flowing movements with positive energy
        - Camera slowly reveals positive elements
        - Light, optimistic pacing
        - Intensity ${intensity}/10: ${intensity > 7 ? 'More dynamic, uplifting movements' : intensity > 4 ? 'Moderate positive energy' : 'Subtle optimistic movements'}`,
      
      'concerned': `
        - Careful, deliberate camera movements
        - Characters show attentive, caring gestures
        - Thoughtful pacing without urgency
        - Camera focuses on expressions of care
        - Respectful distance and framing
        - Intensity ${intensity}/10: ${intensity > 7 ? 'More focused, attentive movements' : intensity > 4 ? 'Moderate concern expression' : 'Gentle, caring movements'}`,
      
      'urgent': `
        - Focused, efficient camera movements
        - Characters move with professional purpose
        - Alert but controlled pacing
        - Camera emphasizes important elements
        - Crisp, clear movements without chaos
        - Intensity ${intensity}/10: ${intensity > 7 ? 'More dynamic, focused movements' : intensity > 4 ? 'Professional urgency' : 'Controlled, purposeful movements'}`,
      
      'informative': `
        - Stable, clear camera work for comprehension
        - Characters use clear, educational gestures
        - Steady pacing supporting information delivery
        - Camera maintains optimal viewing angles
        - Professional, accessible movements
        - Intensity ${intensity}/10: ${intensity > 7 ? 'More demonstrative, clear movements' : intensity > 4 ? 'Standard educational pacing' : 'Gentle, accessible movements'}`,
      
      'celebratory': `
        - Joyful, energetic camera movements
        - Characters show genuine happiness and celebration
        - Uplifting, positive pacing
        - Camera captures celebratory moments
        - Dynamic but controlled festive energy
        - Intensity ${intensity}/10: ${intensity > 7 ? 'More energetic, joyful movements' : intensity > 4 ? 'Moderate celebration energy' : 'Gentle, positive movements'}`,
      
      'reflective': `
        - Slow, contemplative camera movements
        - Characters show thoughtful, introspective gestures
        - Meditative pacing encouraging reflection
        - Camera holds on meaningful moments
        - Peaceful, contemplative flow
        - Intensity ${intensity}/10: ${intensity > 7 ? 'Deeper, more contemplative movements' : intensity > 4 ? 'Moderate reflection' : 'Gentle, peaceful movements'}`,
      
      'professional': `
        - Business-standard camera movements
        - Characters maintain professional demeanor
        - Competent, reliable pacing
        - Camera supports professional presentation
        - Standard business-appropriate motion
        - Intensity ${intensity}/10: ${intensity > 7 ? 'More authoritative, confident movements' : intensity > 4 ? 'Standard professional motion' : 'Gentle, professional movements'}`
    };

    return motionGuidelines[mood] || motionGuidelines['professional'];
  }

  // Enhanced mood-specific Disney prompt generation
  enhancePromptForMoodSpecificDisney(basePrompt, sceneContext, moodConfig) {
    const moodSpecificKeywords = [
      'Disney/Pixar 3D animation visual style',
      `${sceneContext.mood} mood enhancement`,
      `${sceneContext.emotionalTone} atmosphere`,
      `mood intensity ${sceneContext.moodIntensity}/10`,
      'high-quality family-friendly rendering',
      moodConfig.lighting.atmosphere,
      'community cooperation appropriate content',
      `${sceneContext.mood} motion characteristics`,
      'collaborative teamwork focus',
      'positive civic engagement',
      'constructive professional activities'
    ];

    const moodCameraKeywords = {
      'emotional': `${sceneContext.mood} close-up with mood-appropriate camera movement`,
      'action': `${sceneContext.mood} camera movement following positive coordination activities`,
      'landscape': `${sceneContext.mood} establishing shot showing community environment`,
      'dialogue': `${sceneContext.mood} shot with focus on positive conversation`,
      'standard': `${sceneContext.mood} camera movement highlighting professional cooperation`
    };

    let enhanced = basePrompt;
    enhanced += `, ${moodSpecificKeywords.join(', ')}`;
    
    if (sceneContext.sceneType && moodCameraKeywords[sceneContext.sceneType]) {
      enhanced += `, ${moodCameraKeywords[sceneContext.sceneType]}`;
    }

    // Add mood-specific motion characteristics
    enhanced += `, ${moodConfig.motion.pace} emphasizing ${sceneContext.mood} mood with ${sceneContext.emotionalTone}`;

    // Additional mood-specific enhancements
    enhanced += `, ${moodConfig.keywords.join(' and ')} characteristics with ${sceneContext.moodIntensity}/10 mood intensity`;

    return enhanced;
  }

  // UPDATED: Phase 5: Audio Generation with Mood Integration
  async generateAudioAssets(scenes, overallMood) {
    try {
      console.log('🎵 Generating mood-enhanced audio assets...');

      // Generate narration for each scene with mood-appropriate voice settings
      const narrationPaths = [];

      const voiceIds = [
        'EXAVITQu4vr4xnSDxMaL', // Sarah
        'pFZP5JQG7iQjIQuC4Bku', // Lily
        'aXbjk4JoIDXdCNz29TrS', // Sunny
        'onwK4e9ZLuTAKqWW03F9' // Daniel
      ];
      
      // Select voice based on overall mood
      const moodVoiceMapping = {
        'serious': 'onwK4e9ZLuTAKqWW03F9', // Daniel - more authoritative
        'hopeful': 'aXbjk4JoIDXdCNz29TrS', // Sunny - optimistic
        'concerned': 'EXAVITQu4vr4xnSDxMaL', // Sarah - caring
        'urgent': 'onwK4e9ZLuTAKqWW03F9', // Daniel - clear
        'informative': 'pFZP5JQG7iQjIQuC4Bku', // Lily - educational
        'celebratory': 'aXbjk4JoIDXdCNz29TrS', // Sunny - joyful
        'reflective': 'EXAVITQu4vr4xnSDxMaL', // Sarah - thoughtful
        'professional': 'onwK4e9ZLuTAKqWW03F9' // Daniel - professional
      };
      
      const selectedVoiceId = moodVoiceMapping[overallMood] || voiceIds[Math.floor(Math.random() * voiceIds.length)];
      console.log(`🎤 Selected ${overallMood} mood-appropriate voice`);
      
      for (const scene of scenes) {
        if (scene.narration && scene.narration.trim()) {
          const audioPath = await this.generateMoodAwareVoice(
            scene.narration, 
            scene.sceneNumber, 
            selectedVoiceId,
            scene.mood,
            scene.moodIntensity,
            scene.emotionalTone
          );
          if (audioPath) {
            narrationPaths.push({
              sceneNumber: scene.sceneNumber,
              audioPath: audioPath,
              duration: scene.duration,
              mood: scene.mood,
              moodIntensity: scene.moodIntensity
            });
          }
        }
      }

      return {
        narration: narrationPaths,
      };

    } catch (error) {
      console.error('Error generating mood-enhanced audio assets:', error);
      throw new Error('Failed to generate mood-enhanced audio assets');
    }
  }

  // NEW: Generate mood-aware voice with appropriate settings
  async generateMoodAwareVoice(text, sceneNumber, selectedVoiceId, mood, moodIntensity, emotionalTone) {
    try {
      console.log(`🎤 Generating ${mood} mood voice for scene ${sceneNumber} (intensity: ${moodIntensity}/10)`);
      
      if (!this.elevenLabsApiKey) {
        console.warn('ElevenLabs API key not found, skipping voice generation');
        return null;
      }

      // Get mood configuration for voice settings
      const moodConfig = this.getMoodConfiguration(mood);
      
      // Adjust voice settings based on mood
      const voiceSettings = this.getMoodVoiceSettings(mood, moodIntensity, moodConfig);

      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}`,
        {
          text: text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: voiceSettings
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

      const audioPath = path.join(this.workingDir, 'audio', `narration_${sceneNumber}_${mood}.mp3`);
      await fs.writeFile(audioPath, Buffer.from(response.data));
      
      console.log(`✅ Generated ${mood} mood voice for scene ${sceneNumber}`);
      return audioPath;

    } catch (error) {
      console.error('Error generating mood-aware voice:', error);
      return null;
    }
  }

  // NEW: Get mood-specific voice settings
  getMoodVoiceSettings(mood, intensity, moodConfig) {
    const baseMoodSettings = {
      'serious': {
        stability: 0.7,
        similarity_boost: 0.8,
        style: 0.2,
        use_speaker_boost: true
      },
      'hopeful': {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
        use_speaker_boost: true
      },
      'concerned': {
        stability: 0.6,
        similarity_boost: 0.8,
        style: 0.1,
        use_speaker_boost: true
      },
      'urgent': {
        stability: 0.8,
        similarity_boost: 0.85,
        style: 0.4,
        use_speaker_boost: true
      },
      'informative': {
        stability: 0.75,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      },
      'celebratory': {
        stability: 0.4,
        similarity_boost: 0.7,
        style: 0.5,
        use_speaker_boost: true
      },
      'reflective': {
        stability: 0.8,
        similarity_boost: 0.85,
        style: 0.1,
        use_speaker_boost: true
      },
      'professional': {
        stability: 0.75,
        similarity_boost: 0.8,
        style: 0.2,
        use_speaker_boost: true
      }
    };

    const settings = baseMoodSettings[mood] || baseMoodSettings['professional'];
    
    // Adjust settings based on intensity
    const intensityFactor = intensity / 10;
    
    // Adjust style based on intensity
    settings.style = Math.min(1.0, settings.style + (intensityFactor * 0.2));
    
    // Adjust stability inversely with intensity for more dynamic moods
    if (['celebratory', 'hopeful', 'urgent'].includes(mood)) {
      settings.stability = Math.max(0.3, settings.stability - (intensityFactor * 0.2));
    }

    return settings;
  }

  // Phase 6: Updated Video Assembly (unchanged)
  async assembleAnimation(sceneVideos, audioAssets, storyData) {
    try {
      console.log('🎬 Assembling final mood-enhanced animation with audio-video sync and subtitles...');
      
      const processedClipsDir = path.join(this.workingDir, 'processed');
      await fs.mkdir(processedClipsDir, { recursive: true });
      
      const processedClips = [];
      const totalClips = sceneVideos.length;

      // Step 1: Process each scene with mood information
      console.log('📝 Processing individual mood-enhanced scenes...');
      
      for (let i = 0; i < sceneVideos.length; i++) {
        const sceneVideo = sceneVideos[i];
        const sceneAudio = audioAssets.narration.find(n => n.sceneNumber === sceneVideo.sceneNumber);
        
        if (!sceneAudio || !sceneAudio.audioPath) {
          console.warn(`⚠️ No audio found for scene ${sceneVideo.sceneNumber}, skipping processing`);
          continue;
        }

        console.log(`🔧 Processing ${sceneVideo.mood} mood scene ${sceneVideo.sceneNumber}/${totalClips} (intensity: ${sceneVideo.moodIntensity}/10)...`);
        
        const processedClipPath = path.join(processedClipsDir, `processed_scene_${sceneVideo.sceneNumber}_${sceneVideo.mood}.mp4`);
        
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
          duration: actualDuration,
          mood: sceneVideo.mood,
          moodIntensity: sceneVideo.moodIntensity
        });

        console.log(`✅ ${sceneVideo.mood} mood scene ${sceneVideo.sceneNumber} processed (${actualDuration}s, intensity: ${sceneVideo.moodIntensity}/10)`);
      }

      if (processedClips.length === 0) {
        throw new Error('No clips were successfully processed');
      }

      // Step 2: Create concat file for FFmpeg
      console.log('🔗 Concatenating mood-enhanced processed clips...');
      
      const concatFilePath = path.join(this.workingDir, 'concat_list.txt');
      const concatContent = processedClips
        .sort((a, b) => a.sceneNumber - b.sceneNumber)
        .map(clip => `file '${clip.path.replace(/\\/g, '/')}'`)
        .join('\n');
      
      writeFileSync(concatFilePath, concatContent, 'utf8');
      console.log(`📋 Concat file created with ${processedClips.length} mood-enhanced clips`);

      // Step 3: Concatenate all processed clips
      const outputPath = path.join(this.workingDir, `mood_enhanced_animation_${uuidv4()}.mp4`);
      
      return new Promise((resolve, reject) => {
        const ffArgs = [
          '-f', 'concat',
          '-safe', '0',
          '-i', concatFilePath,
          '-c', 'copy',
          '-movflags', '+faststart',
          outputPath
        ];

        console.log(`🎞️ Final mood-enhanced concatenation: ffmpeg ${ffArgs.join(' ')}`);

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
        const moodProgression = processedClips.map(clip => `${clip.mood}(${clip.moodIntensity}/10)`).join(' → ');
        
        console.log(`✅ Mood-enhanced animation assembly completed! Total duration: ${totalDuration.toFixed(1)}s`);
        console.log(`🎭 Mood progression: ${moodProgression}`);
        console.log(`📁 Output: ${outputPath}`);
        
        resolve(outputPath);
      });

    } catch (error) {
      console.error('❌ Error assembling mood-enhanced animation:', error);
      throw new Error(`Failed to assemble mood-enhanced animation: ${error.message}`);
    }
  }

  // Content safety methods (unchanged but with mood awareness)
  sanitizeSceneForContentPolicy(sceneDescription, sceneType) {
    // Determine story type to apply appropriate visual adaptations
    const storyType = this.detectStoryType(sceneDescription);
    
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

  // Content adaptation methods (unchanged)
  adaptCrimeSceneVisuals(description) {
    const crimeVisualAdaptations = {
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

    for (const [crimeVisual, safeVisual] of Object.entries(crimeVisualAdaptations)) {
      const regex = new RegExp(crimeVisual, 'gi');
      if (regex.test(adaptedDescription)) {
        adaptedDescription = adaptedDescription.replace(regex, safeVisual);
        wasModified = true;
      }
    }

    adaptedDescription = adaptedDescription
      .replace(/\b(committing|performing|executing)\s+(a\s+)?(crime|murder|robbery)\b/gi, 'investigating the reported incident')
      .replace(/\b(during|while)\s+the\s+(attack|assault|crime)\b/gi, 'during the investigation')
      .replace(/\b(scene\s+of\s+the\s+)(crime|murder|attack)\b/gi, 'investigation area')
      .replace(/\b(criminal|perpetrator)\s+(escaping|fleeing)\b/gi, 'police coordinating response efforts');

    return { sanitizedDescription: adaptedDescription, wasModified };
  }

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

  // Helper methods (enhanced with mood awareness)
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
      // Enhanced animation data with mood information
      const animation = new Animation({
        title: animationData.title,
        theme: animationData.theme,
        article: animationData.originalArticle,
        sceneCount: animationData.scenes.length,
        characters: animationData.characters,
        scenes: animationData.scenes.map(scene => ({
          ...scene,
          mood: scene.mood,
          moodIntensity: scene.moodIntensity || 5,
          emotionalTone: scene.emotionalTone || scene.mood
        })),
        videoUrl: finalVideoUrl,
        status: 'completed',
        generatedAt: new Date(),
        processingTime: animationData.processingTime,
        overallMood: animationData.overallMood,
        moodProgression: animationData.moodProgression || [],
        countryContext: animationData.countryContext
      });

      await animation.save();
      return animation;

    } catch (error) {
      console.error('Error saving animation to database:', error);
      throw new Error('Failed to save animation to database');
    }
  }

  // UPDATED: Main pipeline execution with comprehensive mood integration
  async generateAnimation(article, sceneCount) {
    const startTime = Date.now();
    let finalVideoPath = null;
    
    try {
      console.log('🎬 Starting comprehensive mood-enhanced Disney animation generation pipeline...');
      console.log(`📄 Article length: ${article.length} characters`);
      console.log(`🎭 Scenes to generate: ${sceneCount}`);

      // Phase 1: Story Development with Enhanced Mood Integration
      console.log('\n📝 Phase 1: Generating mood-enhanced story structure...');
      const storyData = await this.generateStoryStructure(article, sceneCount);
      storyData.originalArticle = article;
      console.log(`✅ Story created: "${storyData.title}"`);
      console.log(`🌍 Country context: ${storyData.countryContext.primaryCountry}`);
      console.log(`🎭 Overall mood: ${storyData.overallMood}`);
      console.log(`🎬 Mood progression: ${storyData.scenes.map(s => `${s.mood}(${s.moodIntensity}/10)`).join(' → ')}`);

      // Phase 2: Character Generation with Mood Capabilities
      console.log('\n🎭 Phase 2: Generating mood-capable character assets...');
      const characterAssets = await this.generateCharacterAssets(storyData.characters, storyData.countryContext);
      console.log(`✅ Generated ${Object.keys(characterAssets).length} mood-capable characters for ${storyData.countryContext.primaryCountry}`);

      // Phase 3: Scene Generation with Comprehensive Mood Enhancement
      console.log('\n🖼️ Phase 3: Generating mood-enhanced scene images...');
      const sceneImages = await this.generateSceneImages(storyData.scenes, characterAssets, storyData.countryContext);
      console.log(`✅ Generated ${sceneImages.length} mood-enhanced scene images`);

      // Phase 4: Video Generation with Mood-Specific Motion
      console.log('\n🎥 Phase 4: Generating mood-specific scene videos...');
      const sceneVideos = await this.generateSceneVideos(sceneImages);
      console.log(`✅ Generated ${sceneVideos.length} mood-enhanced scene videos`);

      // Phase 5: Audio Generation with Mood-Appropriate Voice Settings
      console.log('\n🎵 Phase 5: Generating mood-enhanced audio assets...');
      const audioAssets = await this.generateAudioAssets(storyData.scenes, storyData.overallMood);
      console.log(`✅ Generated mood-appropriate audio for ${audioAssets.narration.length} scenes`);

      // Phase 6: Video Assembly with Mood Progression
      console.log('\n🎬 Phase 6: Assembling final mood-enhanced animation...');
      finalVideoPath = await this.assembleAnimation(sceneVideos, audioAssets, storyData);
      console.log('✅ Mood-enhanced animation assembly completed', finalVideoPath);

      // Save to permanent location
      const outputDir = path.join(process.cwd(), 'public', 'animations');
      await fs.mkdir(outputDir, { recursive: true });
      
      const permanentVideoFileName = `mood_animation_${Date.now()}_${uuidv4()}.mp4`;
      const permanentVideoPath = path.join(outputDir, permanentVideoFileName);
      
      // Copy final video to permanent location
      await fs.copyFile(finalVideoPath, permanentVideoPath);
      console.log(`📁 Final mood-enhanced video saved to: ${permanentVideoPath}`);

      // Save to database with mood information
      const processingTime = Date.now() - startTime;
      storyData.processingTime = processingTime;
      
      const animationRecord = await this.saveAnimationToDatabase(storyData, permanentVideoPath);

      console.log(`\n🎉 Comprehensive mood-enhanced animation generation completed successfully!`);
      console.log(`🌍 Generated for: ${storyData.countryContext.primaryCountry}${storyData.countryContext.primaryCity ? ` (${storyData.countryContext.primaryCity})` : ''}`);
      console.log(`🎭 Overall mood: ${storyData.overallMood}`);
      console.log(`🎬 Mood progression: ${storyData.scenes.map(s => `${s.mood}(${s.moodIntensity}/10)`).join(' → ')}`);
      console.log(`🎨 Mood-specific visual and audio treatment applied throughout`);
      console.log(`🛡️ Content safety with mood preservation maintained`);
      console.log(`⏱️ Total processing time: ${(processingTime / 1000 / 60).toFixed(1)} minutes`);
      console.log(`📂 Final video path: ${permanentVideoPath}`);

      console.log("Cleaning Up Temp Files")
      await this.cleanupTempFiles()
      
      return {
        success: true,
        animationId: animationRecord._id,
        videoPath: permanentVideoPath,
        videoUrl: permanentVideoPath,
        title: storyData.title,
        processingTime: processingTime,
        sceneCount: storyData.scenes.length,
        countryContext: storyData.countryContext,
        overallMood: storyData.overallMood,
        moodProgression: storyData.scenes.map(s => ({
          sceneNumber: s.sceneNumber,
          mood: s.mood,
          intensity: s.moodIntensity,
          emotionalTone: s.emotionalTone
        })),
        moodEnhanced: true
      };

    } catch (error) {
      console.error('❌ Mood-enhanced animation generation failed:', error);
      
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
      
      throw new Error(`Mood-enhanced animation generation failed: ${error.message}`);
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