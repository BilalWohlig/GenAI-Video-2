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
  motionDescription: z.string().max(150) // Reduced from 200 for more concise, subtle descriptions
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
    } catch (error) {
      console.error('Error creating directories:', error);
    }
  }

  // Phase 1: Story Development with Structured Response (Updated for Realistic News)
  async generateStoryStructure(article, sceneCount) {
    const systemPrompt = `You are a professional news animator who creates Disney/Pixar-style 3D animated news stories. Your job is to transform real news articles into visually appealing animated content while maintaining journalistic accuracy and realism. Use Disney/Pixar's high-quality 3D animation style but keep the content factual, realistic, and true to the news story.`;
    
    const userPrompt = `Transform this news article into a realistic Disney/Pixar-style 3D animated news story with exactly ${sceneCount} scenes.

    Article: ${article}

    IMPORTANT GUIDELINES:
    - Keep the story FACTUAL and REALISTIC - no magic, fantasy, or fictional elements
    - Use Disney/Pixar 3D animation VISUAL STYLE only (high-quality 3D rendering, appealing character designs, vibrant colors)
    - Characters should be realistic people/professionals, not magical beings
    - Settings should be real-world locations (offices, cities, laboratories, etc.)
    - Focus on the actual events, people, and facts from the news
    - Make it informative and engaging but grounded in reality
    - Characters should look professional and appropriate for the news context
    - Avoid any Disney-like magical transformations, talking animals, or fantastical elements

    Create:
    - Realistic character descriptions (scientists, politicians, business people, etc.) in Disney/Pixar 3D style
    - Factual scene descriptions based on actual events in the article
    - Professional, news-appropriate narration
    - Scene types optimized for subtle, realistic movements
    - Each scene should be 4-7 seconds duration for clarity`;

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
      console.log(`✅ Realistic news story generated: "${storyData.title}" with ${storyData.characters.length} characters`);
      
      return storyData;
    } catch (error) {
      console.error('Error generating story structure:', error);
      throw new Error('Failed to generate story structure');
    }
  }

  // Phase 2: Character Generation with Reference Images
  async generateCharacterAssets(characters) {
    const characterAssets = {};

    for (const character of characters) {
      try {
        console.log(`🎭 Generating character: ${character.name}`);

        // Generate master character image
        const masterCharacterPrompt = `
        Create a Disney/Pixar style 3D character: ${character.description}. 
        ${character.personality}. Front view, neutral expression, clean white background, 
        high quality 3D rendering, professional Disney/Pixar animation style, 
        vibrant colors, appealing character design.`;

        const masterImagePath = await this.generateImage(masterCharacterPrompt);
        
        // Generate character expressions using master image as reference
        const expressions = ['happy', 'sad', 'surprised', 'determined', 'worried'];
        const characterExpressions = {};
        
        for (const expression of expressions) {
          const expressionPrompt = `
          Change the character's expression to ${expression} while maintaining the exact same character design, 
          style, colors, and physical appearance. Same Disney/Pixar 3D animation style, 
          front view, white background. Keep all character features identical except the facial expression.`;
          
          const expressionImagePath = await this.generateImageWithReference(
            [masterImagePath], 
            expressionPrompt
          );
          characterExpressions[expression] = expressionImagePath;
        }

        characterAssets[character.name] = {
          master: masterImagePath,
          expressions: characterExpressions,
          description: character.description
        };

        // Copy to permanent character directory
        const permanentPath = path.join(this.workingDir, 'characters', `${character.name}_master.png`);
        await fs.copyFile(masterImagePath, permanentPath);
        
        console.log(`✅ Generated character ${character.name} with ${expressions.length} expressions`);
        
      } catch (error) {
        console.error(`Error generating character ${character.name}:`, error);
        throw new Error(`Failed to generate character: ${character.name}`);
      }
    }

    return characterAssets;
  }

  // Phase 3: Scene Generation with Character Reference Images (Updated for Content Safety)
  async generateSceneImages(scenes, characterAssets) {
    const sceneImages = [];

    for (const scene of scenes) {
      try {
        console.log(`🎬 Generating realistic news scene ${scene.sceneNumber}: ${scene.description.substring(0, 50)}...`);

        // Apply content safety filter
        const { sanitizedDescription, wasModified } = this.sanitizeSceneForContentPolicy(scene.description, scene.sceneType);

        // Collect reference images for characters in this scene
        const referenceImages = [];
        let enhancedPrompt = sanitizedDescription; // Use sanitized description

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

        // Build complete realistic scene prompt with content safety considerations
        let fullScenePrompt = `
        Realistic news scene in Disney/Pixar 3D animation style: ${enhancedPrompt}
        Location: ${scene.location}
        Mood: ${scene.mood}
        Camera angle: ${scene.cameraAngle}
        
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
        - Professional, real-world setting appropriate for news content
        - Realistic human characters in appropriate professional attire
        - Modern, contemporary environments (offices, laboratories, city streets, etc.)
        - Maintain journalistic accuracy and realism
        
        Maintain character consistency with the reference images. Keep the exact same character designs, 
        colors, and physical features from the reference images. Ensure professional, realistic appearance.`;

        let sceneImagePath;

        if (referenceImages.length > 0) {
          // Generate scene with character references
          console.log(`   Using ${referenceImages.length} character reference images for content-safe realistic scene`);
          sceneImagePath = await this.generateImageWithReference(referenceImages, fullScenePrompt);
        } else {
          // Generate scene without character references
          sceneImagePath = await this.generateImage(fullScenePrompt);
        }
        
        sceneImages.push({
          sceneNumber: scene.sceneNumber,
          image: sceneImagePath,
          description: scene.description, // Keep original description for narration
          sanitizedDescription: sanitizedDescription, // Store sanitized version
          narration: scene.narration, // Narration remains unchanged
          duration: scene.duration || 5,
          sceneType: scene.sceneType || 'standard',
          charactersUsed: scene.characters || [],
          contentModified: wasModified
        });

        // Copy to permanent scene directory
        const permanentPath = path.join(this.workingDir, 'scenes', `scene_${scene.sceneNumber}.png`);
        await fs.copyFile(sceneImagePath, permanentPath);

        if (wasModified) {
          console.log(`✅ Content-safe realistic news scene ${scene.sceneNumber} generated (content modified for safety)`);
        } else {
          console.log(`✅ Realistic news scene ${scene.sceneNumber} generated with ${scene.characters?.length || 0} character references`);
        }

      } catch (error) {
        console.error(`Error generating scene ${scene.sceneNumber}:`, error);
        throw new Error(`Failed to generate scene: ${scene.sceneNumber}`);
      }
    }

    return sceneImages;
  }

  // Phase 4: Video Generation with Kling AI
  async generateSceneVideos(sceneImages) {
    const sceneVideos = [];

    for (const scene of sceneImages) {
      try {
        console.log(`🎥 Generating video for scene ${scene.sceneNumber}`);

        // Generate motion description using GPT-4 with structured response (Updated for Content Safety & Subtle Movements)
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

        // Apply additional content safety filter to motion description
        // motionDescription = this.sanitizeMotionForContentPolicy(motionDescription);

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

  // Enhanced Disney prompt generation (Updated for Realistic News Content with Subtle Movements)
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

    // Add explicit instruction for subtle movement
    enhanced += ', extremely subtle and slow movements to prevent distortion';

    return enhanced;
  }

  // Phase 5: Audio Generation
  async generateAudioAssets(scenes, overallMood) {
    try {
      console.log('🎵 Generating audio assets...');

      // Generate narration for each scene
      const narrationPaths = [];
      
      for (const scene of scenes) {
        if (scene.narration && scene.narration.trim()) {
          const audioPath = await this.generateVoice(scene.narration, scene.sceneNumber);
          narrationPaths.push({
            sceneNumber: scene.sceneNumber,
            audioPath: audioPath,
            duration: scene.duration
          });
        }
      }

      // Generate background music
      const musicPath = await this.generateBackgroundMusic(overallMood, scenes.length * 5);

      return {
        narration: narrationPaths,
        backgroundMusic: musicPath
      };

    } catch (error) {
      console.error('Error generating audio assets:', error);
      throw new Error('Failed to generate audio assets');
    }
  }

  // Phase 6: Video Assembly with FFmpeg
  async assembleAnimation(sceneVideos, audioAssets, storyData) {
    try {
      console.log('🎬 Assembling final animation...');
      const outputPath = path.join(this.workingDir, `animation_${uuidv4()}.mp4`);
      
      return new Promise((resolve, reject) => {
        let command = ffmpeg();

        // Add all scene videos in order
        sceneVideos
          .sort((a, b) => a.sceneNumber - b.sceneNumber)
          .forEach(scene => {
            command = command.input(scene.videoPath);
          });

        // Add background music if available
        if (audioAssets.backgroundMusic) {
          command = command.input(audioAssets.backgroundMusic);
        }

        // Create filter complex for video concatenation
        let filterComplex = '';
        let inputs = '';

        // Video concatenation
        sceneVideos.forEach((scene, index) => {
          inputs += `[${index}:v]`;
        });
        
        filterComplex += `${inputs}concat=n=${sceneVideos.length}:v=1:a=0[video];`;

        // Audio processing
        if (audioAssets.backgroundMusic) {
          filterComplex += `[${sceneVideos.length}:a]volume=0.3[bgm];`;
          
          // Add narration tracks if available
          if (audioAssets.narration && audioAssets.narration.length > 0) {
            audioAssets.narration.forEach((narration, index) => {
              command = command.input(narration.audioPath);
            });
            
            let audioMix = '[bgm]';
            audioAssets.narration.forEach((narration, index) => {
              audioMix += `[${sceneVideos.length + 1 + index}:a]`;
            });
            audioMix += `amix=inputs=${audioAssets.narration.length + 1}:duration=longest[audio]`;
            filterComplex += audioMix;
          } else {
            filterComplex += '[bgm]acopy[audio];';
          }
        } else {
          // No background music, just use first video's audio or create silent audio
          filterComplex += 'anullsrc=channel_layout=stereo:sample_rate=48000[audio];';
        }

        command
          .complexFilter(filterComplex)
          .outputOptions([
            '-map [video]',
            '-map [audio]',
            '-c:v libx264',
            '-c:a aac',
            '-r 24',
            '-pix_fmt yuv420p',
            '-movflags +faststart' // For web streaming
          ])
          .output(outputPath)
          .on('progress', (progress) => {
            console.log(`Assembly progress: ${Math.round(progress.percent || 0)}%`);
          })
          .on('end', () => {
            console.log('✅ Video assembly completed');
            resolve(outputPath);
          })
          .on('error', (err) => {
            console.error('❌ Video assembly error:', err);
            reject(err);
          })
          .run();
      });

    } catch (error) {
      console.error('Error assembling animation:', error);
      throw new Error('Failed to assemble animation');
    }
  }

  // Content Safety Filter for Sensitive News Content
  sanitizeSceneForContentPolicy(sceneDescription, sceneType) {
    // Keywords that might trigger content policy violations
    const sensitiveKeywords = {
      // Violence and weapons
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
      
      // Accidents and disasters
      'crash': 'aftermath scene with emergency responders',
      'accident': 'emergency response and investigation',
      'fire': 'firefighters responding and aftermath cleanup',
      'disaster': 'rescue operations and community support',
      
      // Protests and civil unrest
      'riot': 'peaceful community dialogue and cleanup efforts',
      'protest': 'peaceful demonstration and community voices',
      'clash': 'community leaders discussing solutions',
      
      // Medical emergencies
      'pandemic': 'healthcare workers and community support',
      'outbreak': 'medical professionals and prevention measures',
      'emergency': 'first responders and community assistance'
    };

    let sanitizedDescription = sceneDescription.toLowerCase();
    let wasModified = false;

    // Replace sensitive content with aftermath/response alternatives
    for (const [sensitiveWord, safeAlternative] of Object.entries(sensitiveKeywords)) {
      const regex = new RegExp(`\\b${sensitiveWord}\\b`, 'gi');
      if (regex.test(sanitizedDescription)) {
        sanitizedDescription = sanitizedDescription.replace(regex, safeAlternative);
        wasModified = true;
      }
    }

    // Additional safety transformations
    if (wasModified) {
      // Remove action words that might show violence
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
  async generateImage(prompt) {
    try {
      const response = await this.openai.images.generate({
        model: 'gpt-image-1',
        prompt: prompt,
        size: '1536x1024',
        quality: 'high',
        // response_format: 'b64_json',
        n: 1
      });

      // Get base64 data from response
      const base64Data = response.data[0].b64_json;
      
      // Convert base64 to buffer and save to temp file
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const tempImagePath = path.join(this.workingDir, `temp_image_${uuidv4()}.png`);
      
      await fs.writeFile(tempImagePath, imageBuffer);
      
      console.log(`✅ Image generated with gpt-image-1 (${response.usage?.total_tokens || 'N/A'} tokens)`);
      
      return tempImagePath; // Return local file path instead of URL
    } catch (error) {
      console.error('Error generating image:', error);
      throw new Error('Failed to generate image');
    }
  }

  // New method: Generate image with reference images
  async generateImageWithReference(referenceImagePaths, prompt) {
    try {
      console.log(`🖼️ Generating image with ${referenceImagePaths.length} reference images`);

      // Convert file paths to OpenAI file objects
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
        // response_format: 'b64_json'
      });

      // Get base64 data from response
      const base64Data = response.data[0].b64_json;
      
      // Convert base64 to buffer and save to temp file
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const tempImagePath = path.join(this.workingDir, `temp_ref_image_${uuidv4()}.png`);
      
      await fs.writeFile(tempImagePath, imageBuffer);
      
      console.log(`✅ Reference image generated with gpt-image-1 (${response.usage?.total_tokens || 'N/A'} tokens)`);
      
      return tempImagePath;
    } catch (error) {
      console.error('Error generating image with reference:', error);
      
      // Fallback: Generate without reference if reference generation fails
      console.log('🔄 Falling back to generation without reference images');
      return await this.generateImage(prompt);
    }
  }

  async generateVoice(text, sceneNumber) {
    try {
      if (!this.elevenLabsApiKey) {
        console.warn('ElevenLabs API key not found, skipping voice generation');
        return null;
      }

      const voiceIds = [
        'EXAVITQu4vr4xnSDxMaL', // Sarah
        'AZnzlk1XvdvUeBnXmlld', // Domi
        'aXbjk4JoIDXdCNz29TrS', // Sunny
        'onwK4e9ZLuTAKqWW03F9' // Daniel
      ]
      const selectedVoiceId = voiceIds[Math.floor(Math.random() * voiceIds.length)]

      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}`,
        {
          text: text,
          model_id: 'eleven_monolingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
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
      await fs.writeFile(audioPath, response.data);
      return audioPath;

    } catch (error) {
      console.error('Error generating voice:', error);
      return null; // Continue without voice if it fails
    }
  }

  async generateBackgroundMusic(mood, duration) {
    try {
      // Placeholder for background music generation
      // For now, create a silent audio file
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

  // Convert local image file for Kling AI usage
  async convertLocalImageForKlingAI(localImagePath) {
    try {
      // Option 1: Upload to ImageKit temporarily and return URL
      if (this.imagekitApiKey && this.imagekitPrivateKey && this.imagekitEndpoint) {
        const tempFileName = `temp_${uuidv4()}.png`;
        const tempUrl = await this.uploadToImageKit(localImagePath, tempFileName);
        return tempUrl;
      }
      
      // Option 2: Convert to data URL (base64)
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
      // This method is now only used for downloading from URLs
      // Since gpt-image-1 returns base64, this is mainly for fallback scenarios
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
      
      // Ensure directory exists
      const dir = path.dirname(targetPath);
      await fs.mkdir(dir, { recursive: true });
      
      if (imagePathOrUrl.startsWith('http')) {
        // It's a URL, download it
        await this.downloadImage(imagePathOrUrl, filename);
      } else {
        // It's a local file path, copy it
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

  // Main pipeline execution
  async generateAnimation(article, sceneCount) {
    const startTime = Date.now();
    let finalVideoPath = null;
    
    try {
      console.log('🎬 Starting Disney animation generation pipeline...');
      console.log(`📄 Article length: ${article.length} characters`);
      console.log(`🎭 Scenes to generate: ${sceneCount}`);

      // Phase 1: Story Development
      console.log('\n📝 Phase 1: Generating story structure...');
      const storyData = await this.generateStoryStructure(article, sceneCount);
      storyData.originalArticle = article;
      console.log(`✅ Story created: "${storyData.title}"`);

      // Phase 2: Character Generation
      console.log('\n🎭 Phase 2: Generating character assets...');
      const characterAssets = await this.generateCharacterAssets(storyData.characters);
      console.log(`✅ Generated ${Object.keys(characterAssets).length} characters`);

      // Phase 3: Scene Generation
      console.log('\n🖼️ Phase 3: Generating scene images...');
      const sceneImages = await this.generateSceneImages(storyData.scenes, characterAssets);
      console.log(`✅ Generated ${sceneImages.length} scene images`);

      // Phase 4: Video Generation
      console.log('\n🎥 Phase 4: Generating scene videos with Kling AI...');
      const sceneVideos = await this.generateSceneVideos(sceneImages);
      console.log(`✅ Generated ${sceneVideos.length} scene videos`);

      // Phase 5: Audio Generation
      console.log('\n🎵 Phase 5: Generating audio assets...');
      const audioAssets = await this.generateAudioAssets(storyData.scenes, storyData.overallMood);
      console.log(`✅ Generated audio for ${audioAssets.narration.length} scenes`);

      // Phase 6: Video Assembly
      console.log('\n🎬 Phase 6: Assembling final animation...');
      finalVideoPath = await this.assembleAnimation(sceneVideos, audioAssets, storyData);
      console.log('✅ Animation assembly completed');

      // Upload to ImageKit
      console.log('\n☁️ Uploading to ImageKit...');
      const videoFileName = `animation_${Date.now()}.mp4`;
      const finalVideoUrl = await this.uploadToImageKit(finalVideoPath, videoFileName);
      console.log('✅ Upload completed');

      // Save to database
      const processingTime = Date.now() - startTime;
      storyData.processingTime = processingTime;
      
      const animationRecord = await this.saveAnimationToDatabase(storyData, finalVideoUrl);

      // Cleanup temp files
      await this.cleanupTempFiles();

      console.log(`\n🎉 Animation generation completed successfully!`);
      console.log(`⏱️ Total processing time: ${(processingTime / 1000 / 60).toFixed(1)} minutes`);
      
      return {
        success: true,
        animationId: animationRecord._id,
        videoUrl: finalVideoUrl,
        title: storyData.title,
        processingTime: processingTime,
        sceneCount: storyData.scenes.length
      };

    } catch (error) {
      console.error('❌ Animation generation failed:', error);
      
      // Cleanup on error
      if (finalVideoPath) {
        try {
          await fs.unlink(finalVideoPath);
        } catch (cleanupError) {
          console.error('Error cleaning up video file:', cleanupError);
        }
      }
      
      throw new Error(`Animation generation failed: ${error.message}`);
    }
  }

  async cleanupTempFiles() {
    try {
      console.log('🧹 Cleaning up temporary files...');
      
      const directories = ['characters', 'scenes', 'videos', 'audio'];
      
      for (const dir of directories) {
        const dirPath = path.join(this.workingDir, dir);
        try {
          const files = await fs.readdir(dirPath);
          for (const file of files) {
            const filePath = path.join(dirPath, file);
            await fs.unlink(filePath);
          }
        } catch (error) {
          // Directory might not exist or be empty, ignore
        }
      }
      
      console.log('✅ Cleanup completed');
    } catch (error) {
      console.error('Error cleaning up temp files:', error);
    }
  }
}

module.exports = new AnimationService();