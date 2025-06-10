// services/animation/klingAIService.js - Enhanced with mood support
const axios = require('axios');
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const FormData = require('form-data');
const path = require('path');
const Replicate = require('replicate');

class KlingAIService {
  constructor() {
    this.accessKey = process.env.KLING_ACCESS_KEY;
    this.secretKey = process.env.KLING_SECRET_KEY;
    this.replicateApiToken = process.env.REPLICATE_API_TOKEN;
    this.baseURL = 'https://api-singapore.klingai.com/v1';
    
    // Initialize Replicate client
    if (this.replicateApiToken) {
      this.replicate = new Replicate({
        auth: this.replicateApiToken,
      });
    }
    
    if (!this.accessKey || !this.secretKey) {
      console.warn('⚠️ Kling AI credentials not found. Please set KLING_ACCESS_KEY and KLING_SECRET_KEY environment variables.');
    }

    if (!this.replicateApiToken) {
      console.warn('⚠️ Replicate API token not found. Please set REPLICATE_API_TOKEN environment variable.');
    }

    this.defaultSettings = {
      maxRetries: 3,
      pollInterval: 10000, // 10 seconds
      maxPollAttempts: 60, // 10 minutes total
      timeout: {
        upload: 30000,
        generate: 60000,
        download: 300000
      }
    };

    // Mood-specific generation settings
    this.moodSettings = {
      'serious': {
        cfg_scale: 0.6,
        preferredMode: 'std',
        cameraStyle: 'steady',
        motionIntensity: 'controlled'
      },
      'hopeful': {
        cfg_scale: 0.4,
        preferredMode: 'std',
        cameraStyle: 'gentle_upward',
        motionIntensity: 'flowing'
      },
      'concerned': {
        cfg_scale: 0.5,
        preferredMode: 'std',
        cameraStyle: 'careful',
        motionIntensity: 'thoughtful'
      },
      'urgent': {
        cfg_scale: 0.7,
        preferredMode: 'std',
        cameraStyle: 'focused',
        motionIntensity: 'efficient'
      },
      'informative': {
        cfg_scale: 0.3,
        preferredMode: 'std',
        cameraStyle: 'stable',
        motionIntensity: 'clear'
      },
      'celebratory': {
        cfg_scale: 0.4,
        preferredMode: 'std',
        cameraStyle: 'dynamic',
        motionIntensity: 'joyful'
      },
      'reflective': {
        cfg_scale: 0.6,
        preferredMode: 'std',
        cameraStyle: 'slow',
        motionIntensity: 'contemplative'
      },
      'professional': {
        cfg_scale: 0.5,
        preferredMode: 'std',
        cameraStyle: 'business_standard',
        motionIntensity: 'competent'
      }
    };
    // this.moodSettings = {
    //   'serious': {
    //     cfg_scale: 0.6,
    //     preferredMode: 'pro',
    //     cameraStyle: 'steady',
    //     motionIntensity: 'controlled'
    //   },
    //   'hopeful': {
    //     cfg_scale: 0.4,
    //     preferredMode: 'std',
    //     cameraStyle: 'gentle_upward',
    //     motionIntensity: 'flowing'
    //   },
    //   'concerned': {
    //     cfg_scale: 0.5,
    //     preferredMode: 'pro',
    //     cameraStyle: 'careful',
    //     motionIntensity: 'thoughtful'
    //   },
    //   'urgent': {
    //     cfg_scale: 0.7,
    //     preferredMode: 'pro',
    //     cameraStyle: 'focused',
    //     motionIntensity: 'efficient'
    //   },
    //   'informative': {
    //     cfg_scale: 0.3,
    //     preferredMode: 'std',
    //     cameraStyle: 'stable',
    //     motionIntensity: 'clear'
    //   },
    //   'celebratory': {
    //     cfg_scale: 0.4,
    //     preferredMode: 'std',
    //     cameraStyle: 'dynamic',
    //     motionIntensity: 'joyful'
    //   },
    //   'reflective': {
    //     cfg_scale: 0.6,
    //     preferredMode: 'pro',
    //     cameraStyle: 'slow',
    //     motionIntensity: 'contemplative'
    //   },
    //   'professional': {
    //     cfg_scale: 0.5,
    //     preferredMode: 'pro',
    //     cameraStyle: 'business_standard',
    //     motionIntensity: 'competent'
    //   }
    // };
  }

  // Get mood-specific settings
  getMoodSettings(mood, moodIntensity = 5) {
    const baseMoodSettings = this.moodSettings[mood] || this.moodSettings['professional'];
    
    // Adjust settings based on mood intensity (1-10 scale)
    const intensityFactor = moodIntensity / 10;
    
    return {
      ...baseMoodSettings,
      cfg_scale: Math.min(1.0, baseMoodSettings.cfg_scale + (intensityFactor * 0.2)),
      moodIntensity: moodIntensity,
      intensityFactor: intensityFactor
    };
  }

  // Validate credentials
  validateCredentials() {
    if (!this.accessKey || !this.secretKey) {
      throw new Error('Kling AI credentials are required. Set KLING_ACCESS_KEY and KLING_SECRET_KEY environment variables.');
    }
    return true;
  }

  // Generate video using Replicate with mood support (Primary method)
  async generateVideoViaReplicate(imageUrl, prompt, duration = 5, aspectRatio = '16:9', mode = 'std', mood = 'professional', moodIntensity = 5) {
    try {
      if (!this.replicateApiToken) {
        throw new Error('Replicate API token not available');
      }

      console.log(`🚀 Attempting ${mood} mood video generation via Replicate (intensity: ${moodIntensity}/10)...`);
      console.log(`   Image: ${imageUrl.substring(0, 50)}...`);
      console.log(`   Prompt: ${prompt}`);
      console.log(`   Duration: 10s, Mode: ${mode}, Mood: ${mood}`);

      // Get mood-specific settings
      const moodSettings = this.getMoodSettings(mood, moodIntensity);

      // Choose model based on mode and mood preferences
      const model = moodSettings.preferredMode === 'pro' 
        ? 'kwaivgi/kling-v1.6-pro:03b02153924ef65cd57b7e561f3a4ed66db11c34218d2c70a8af198987edfa3d'
        : 'kwaivgi/kling-v1.6-standard';

      // Enhance prompt with mood-specific motion characteristics
      const moodEnhancedPrompt = this.enhancePromptWithMoodCharacteristics(prompt, mood, moodSettings);

      const input = {
        prompt: moodEnhancedPrompt,
        duration: 10,
        cfg_scale: moodSettings.cfg_scale,
        start_image: imageUrl,
        aspect_ratio: aspectRatio,
        negative_prompt: this.getMoodSpecificNegativePrompt(mood)
      };

      console.log(`🎬 Using Replicate model: ${model.split(':')[0]} with ${mood} mood optimization`);
      
      const output = await this.replicate.run(model, { input });
      const replicateVideoUrl = output.url().href
      
      console.log(`✅ ${mood} mood Replicate video generation successful!`);
      console.log(`   Video URL: ${replicateVideoUrl}`);

      return {
        success: true,
        videoUrl: replicateVideoUrl,
        duration: 10,
        method: 'replicate',
        mood: mood,
        moodIntensity: moodIntensity
      };

    } catch (error) {
      console.error(`❌ ${mood} mood Replicate video generation failed:`, error.message);
      throw error;
    }
  }

  // Enhance prompt with mood characteristics
  enhancePromptWithMoodCharacteristics(basePrompt, mood, moodSettings) {
    const moodMotionDescriptors = {
      'serious': 'steady, controlled movements, professional camera work, dignified pacing',
      'hopeful': 'gentle upward movements, optimistic camera flow, positive energy',
      'concerned': 'careful, thoughtful movements, respectful camera work, considerate pacing',
      'urgent': 'focused, efficient movements, alert camera work, purposeful pacing',
      'informative': 'stable, clear movements, educational camera work, accessible pacing',
      'celebratory': 'joyful, dynamic movements, celebratory camera work, energetic pacing',
      'reflective': 'slow, contemplative movements, meditative camera work, peaceful pacing',
      'professional': 'business-standard movements, competent camera work, reliable pacing'
    };

    const moodCameraWork = {
      'serious': 'steady camera, minimal movement, professional framing',
      'hopeful': 'gentle upward camera movement, optimistic angles',
      'concerned': 'careful camera positioning, respectful framing',
      'urgent': 'focused camera work, efficient movements',
      'informative': 'stable camera, clear educational shots',
      'celebratory': 'dynamic camera work, joyful movements',
      'reflective': 'slow camera movements, contemplative shots',
      'professional': 'business-standard camera work, competent framing'
    };

    let enhanced = basePrompt;
    
    // Add mood-specific motion descriptors
    if (moodMotionDescriptors[mood]) {
      enhanced += `, ${moodMotionDescriptors[mood]}`;
    }
    
    // Add mood-specific camera work
    if (moodCameraWork[mood]) {
      enhanced += `, ${moodCameraWork[mood]}`;
    }
    
    // Add intensity-based modifications
    const intensityDescriptors = {
      low: 'subtle, gentle',
      medium: 'balanced, moderate',
      high: 'pronounced, dynamic'
    };
    
    const intensityLevel = moodSettings.moodIntensity <= 3 ? 'low' : 
                          moodSettings.moodIntensity <= 7 ? 'medium' : 'high';
    
    enhanced += `, ${intensityDescriptors[intensityLevel]} ${mood} mood expression`;
    
    return enhanced;
  }

  // Get mood-specific negative prompts
  getMoodSpecificNegativePrompt(mood) {
    const baseMoodNegatives = {
      'serious': 'chaotic movement, sudden changes, unprofessional behavior, casual atmosphere',
      'hopeful': 'negative expressions, downward movement, pessimistic atmosphere, dark mood',
      'concerned': 'careless behavior, rushed movements, insensitive actions, dismissive attitude',
      'urgent': 'chaotic panic, disorganized movement, unprofessional urgency, frantic behavior',
      'informative': 'confusing movements, unclear presentation, distracting elements, poor visibility',
      'celebratory': 'sad expressions, downward movement, negative atmosphere, somber mood',
      'reflective': 'rushed movements, chaotic activity, distracting elements, agitated behavior',
      'professional': 'unprofessional behavior, casual atmosphere, sloppy presentation, informal conduct'
    };

    const baseNegative = 'low quality, blurry, distorted, violent content, inappropriate material, text overlays';
    const moodSpecific = baseMoodNegatives[mood] || baseMoodNegatives['professional'];
    
    return `${baseNegative}, ${moodSpecific}`;
  }

  // Generate JWT token for authentication
  generateJWTToken() {
    this.validateCredentials();
    
    const currentTime = Math.floor(Date.now() / 1000);
    
    const headers = {
      "alg": "HS256",
      "typ": "JWT"
    };

    const payload = {
      "iss": this.accessKey,
      "exp": currentTime + 1800, // Valid for 30 minutes
      "nbf": currentTime - 5     // Valid from 5 seconds ago
    };

    try {
      const token = jwt.sign(payload, this.secretKey, { header: headers });
      return token;
    } catch (error) {
      console.error('Error generating JWT token:', error);
      throw new Error('Failed to generate JWT authentication token');
    }
  }

  // Generate authentication headers
  getAuthHeaders() {
    const token = this.generateJWTToken();
    
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  // Make authenticated request with retry logic
  async makeAuthenticatedRequest(method, path, data = null, customHeaders = {}) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.defaultSettings.maxRetries; attempt++) {
      try {
        const headers = { ...this.getAuthHeaders(), ...customHeaders };
        
        // Remove Content-Type if custom headers override it
        if (customHeaders['Content-Type'] && customHeaders['Content-Type'] !== 'application/json') {
          delete headers['Content-Type'];
        }

        const config = {
          method,
          url: `${this.baseURL}${path}`,
          headers,
          timeout: this.defaultSettings.timeout.generate
        };

        if (data && method !== 'GET') {
          config.data = data;
        }

        const response = await axios(config);
        return response.data;

      } catch (error) {
        lastError = error;
        console.error(`Kling AI request attempt ${attempt} failed:`, {
          error: error.message,
          status: error.response?.status,
          data: error.response?.data
        });

        // If it's an auth error, regenerate token on next attempt
        if (error.response?.status === 401 || error.response?.status === 403) {
          console.log('🔑 Authentication error, will regenerate token on next attempt');
        }

        if (attempt < this.defaultSettings.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`⏳ Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Kling AI request failed after ${this.defaultSettings.maxRetries} attempts: ${lastError.message}`);
  }

  // Upload image to Kling AI
  async uploadImage(imageUrl) {
    try {
      console.log('📤 Uploading image to Kling AI...');

      // Download image first
      const imageResponse = await axios({
        method: 'GET',
        url: imageUrl,
        responseType: 'arraybuffer',
        timeout: this.defaultSettings.timeout.download
      });

      const imageBuffer = Buffer.from(imageResponse.data);
      
      if (imageBuffer.length > 10 * 1024 * 1024) {
        throw new Error('Image file too large (max 10MB)');
      }

      // Create form data
      const formData = new FormData();
      formData.append('file', imageBuffer, {
        filename: 'scene.png',
        contentType: 'image/png'
      });

      const token = this.generateJWTToken();
      const headers = {
        'Authorization': `Bearer ${token}`,
        ...formData.getHeaders()
      };

      const response = await axios.post(`${this.baseURL}/images/upload`, formData, {
        headers,
        timeout: this.defaultSettings.timeout.upload
      });

      if (response.data.code === 0) {
        console.log('✅ Image uploaded successfully');
        return response.data.data.url;
      } else {
        throw new Error(`Image upload failed: ${response.data.message}`);
      }

    } catch (error) {
      console.error('❌ Error uploading image:', error.message);
      throw new Error(`Failed to upload image: ${error.message}`);
    }
  }

  // UPDATED: Generate video from image with mood support
  async generateVideo(imageUrl, prompt, duration = 5, aspectRatio = '16:9', mode = 'std', mood = 'professional', moodIntensity = 5) {
    try {
      // First attempt: Try Replicate with mood support
      try {
        console.log(`🎯 Primary attempt: Using Replicate API with ${mood} mood...`);
        return await this.generateVideoViaReplicate(imageUrl, prompt, duration, aspectRatio, mode, mood, moodIntensity);
      } catch (replicateError) {
        console.warn(`⚠️ Replicate failed for ${mood} mood, falling back to direct Kling AI API`);
        console.warn(`   Replicate error: ${replicateError.message}`);
      }

      // Fallback: Use direct Kling AI API with mood support
      console.log(`🔄 Fallback: Using direct Kling AI API with ${mood} mood...`);
      return await this.generateVideoViaDirect(imageUrl, prompt, duration, aspectRatio, mode, mood, moodIntensity);

    } catch (error) {
      console.error(`❌ All ${mood} mood video generation methods failed:`, error.message);
      throw new Error(`Failed to generate ${mood} mood video: ${error.message}`);
    }
  }

  // UPDATED: Generate video via direct Kling AI API with mood support
  async generateVideoViaDirect(imageUrl, prompt, duration = 5, aspectRatio = '16:9', mode = 'std', mood = 'professional', moodIntensity = 5) {
    try {
      console.log(`🎬 Generating ${mood} mood video with direct Kling AI API (intensity: ${moodIntensity}/10)...`);

      // Get mood-specific settings
      const moodSettings = this.getMoodSettings(mood, moodIntensity);
      
      // Enhance prompt with mood characteristics
      const moodEnhancedPrompt = this.enhancePromptWithMoodCharacteristics(prompt, mood, moodSettings);

      const requestBody = {
        model_name: 'kling-v1-6',
        image: imageUrl,
        prompt: moodEnhancedPrompt,
        duration: "10",
        mode: moodSettings.preferredMode,
        cfg_scale: moodSettings.cfg_scale
      };

      const response = await this.makeAuthenticatedRequest('POST', '/videos/image2video', requestBody);

      if (response.code === 0) {
        const taskId = response.data.task_id;
        console.log(`✅ Direct API ${mood} mood video generation started with task ID: ${taskId}`);
        
        const result = await this.pollVideoGeneration(taskId);
        return {
          ...result,
          method: 'direct_api',
          mood: mood,
          moodIntensity: moodIntensity
        };
      } else {
        throw new Error(`${mood} mood video generation failed: ${response.message}`);
      }

    } catch (error) {
      console.error(`❌ Direct API ${mood} mood video generation error:`, error.message);
      throw new Error(`Failed to generate ${mood} mood video via direct API: ${error.message}`);
    }
  }

  // UPDATED: Generate video with camera controls and mood support
  async generateVideoWithCameraControl(imageUrl, prompt, duration = 5, cameraControl = {}, mood = 'professional', moodIntensity = 5) {
    try {
      // First attempt: Try Replicate with mood-enhanced prompt
      try {
        console.log(`🎯 Primary attempt: Using Replicate API with ${mood} mood and enhanced camera control...`);
        
        // Get mood settings
        const moodSettings = this.getMoodSettings(mood, moodIntensity);
        
        // Enhance prompt with both camera control and mood characteristics
        let enhancedPrompt = prompt;
        if (cameraControl.config && !cameraControl.config.tilt) {
          const cameraDescriptions = {
            'pan': `smooth panning camera movement with ${mood} mood characteristics`,
            'zoom': cameraControl.config.zoom > 0 ? 
              `slow zoom in camera movement emphasizing ${mood} mood` : 
              `slow zoom out camera movement maintaining ${mood} mood`,
            'horizontal': `horizontal camera movement with ${mood} pacing`,
            'vertical': `vertical camera movement reflecting ${mood} energy`
          };
          
          if (cameraDescriptions[cameraControl.type]) {
            enhancedPrompt += `, ${cameraDescriptions[cameraControl.type]}`;
          }
        }
        
        return await this.generateVideoViaReplicate(imageUrl, enhancedPrompt, duration, '16:9', 'std', mood, moodIntensity);
      } catch (replicateError) {
        console.warn(`⚠️ Replicate failed for ${mood} mood camera control, falling back to direct Kling AI API`);
        console.warn(`   Replicate error: ${replicateError.message}`);
      }

      // Fallback: Use direct Kling AI API with camera controls and mood
      console.log(`🔄 Fallback: Using direct Kling AI API with ${mood} mood camera controls...`);
      return await this.generateVideoWithCameraControlDirect(imageUrl, prompt, duration, cameraControl, mood, moodIntensity);

    } catch (error) {
      console.error(`❌ All ${mood} mood camera control video generation methods failed:`, error.message);
      throw new Error(`Failed to generate ${mood} mood video with camera control: ${error.message}`);
    }
  }

  // UPDATED: Generate video with camera controls via direct API with mood
  async generateVideoWithCameraControlDirect(imageUrl, prompt, duration = 5, cameraControl = {}, mood = 'professional', moodIntensity = 5) {
    try {
      console.log(`🎥 Generating ${mood} mood video with camera controls via direct API (intensity: ${moodIntensity}/10)...`);
      
      // Get mood-specific settings
      const moodSettings = this.getMoodSettings(mood, moodIntensity);
      
      // Enhance prompt with mood characteristics
      const moodEnhancedPrompt = this.enhancePromptWithMoodCharacteristics(prompt, mood, moodSettings);

      const requestBody = {
        model_name: 'kling-v1-6',
        image: imageUrl,
        prompt: moodEnhancedPrompt,
        duration: "10",
        mode: 'pro', // Camera controls typically require pro mode
        cfg_scale: moodSettings.cfg_scale
      };

      // Add camera control if provided and compatible with mood
      if (cameraControl.config && !cameraControl.config.tilt) {
        requestBody.camera_control = cameraControl;
      }

      const response = await this.makeAuthenticatedRequest('POST', '/videos/image2video', requestBody);

      if (response.code === 0) {
        const result = await this.pollVideoGeneration(response.data.task_id);
        return {
          ...result,
          method: 'direct_api_camera',
          mood: mood,
          moodIntensity: moodIntensity
        };
      } else {
        throw new Error(`${mood} mood video generation with camera control failed: ${response.message}`);
      }

    } catch (error) {
      console.error(`❌ Direct API ${mood} mood camera control video generation error:`, error.message);
      throw new Error(`Failed to generate ${mood} mood video with camera control via direct API: ${error.message}`);
    }
  }

  // Poll video generation status
  async pollVideoGeneration(taskId) {
    let attempts = 0;
    console.log(`📊 Polling video generation for task: ${taskId}`);

    while (attempts < this.defaultSettings.maxPollAttempts) {
      try {
        const response = await this.makeAuthenticatedRequest('GET', `/videos/generations/${taskId}`);

        if (response.code === 0) {
          const task = response.data;
          
          console.log(`   Status: ${task.status} (attempt ${attempts + 1})`);

          switch (task.status) {
            case 'submitted':
            case 'processing':
              break;
              
            case 'succeed':
              console.log('✅ Video generation completed!');
              return {
                success: true,
                videoUrl: task.task_result.videos[0].url,
                duration: task.task_result.duration || 5,
                taskId: taskId
              };
              
            case 'failed':
              const failReason = task.task_result?.fail_reason || 'Unknown error';
              throw new Error(`Video generation failed: ${failReason}`);
              
            default:
              console.warn(`Unknown status: ${task.status}`);
              break;
          }
        }

        if (attempts < this.defaultSettings.maxPollAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, this.defaultSettings.pollInterval));
        }
        attempts++;

      } catch (error) {
        console.error(`Polling error (attempt ${attempts + 1}):`, error.message);
        attempts++;
        
        if (attempts >= this.defaultSettings.maxPollAttempts) {
          throw new Error(`Video generation polling failed: ${error.message}`);
        }
        
        const retryDelay = Math.min(this.defaultSettings.pollInterval * Math.pow(1.5, attempts), 30000);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    throw new Error(`Video generation timed out after ${this.defaultSettings.maxPollAttempts} attempts`);
  }

  // Download video from Kling AI
  async downloadVideo(videoUrl, outputPath) {
    try {
      console.log('⬇️ Downloading video...');

      const outputDir = path.dirname(outputPath);
      await fs.mkdir(outputDir, { recursive: true });

      const response = await axios({
        method: 'GET',
        url: videoUrl,
        responseType: 'stream',
        timeout: this.defaultSettings.timeout.download
      });

      const writer = require('fs').createWriteStream(outputPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log('✅ Video downloaded successfully');
          resolve(outputPath);
        });
        writer.on('error', reject);
      });

    } catch (error) {
      console.error('❌ Video download error:', error.message);
      throw new Error(`Failed to download video: ${error.message}`);
    }
  }

  // UPDATED: Enhanced video generation with mood-aware fallbacks
  async generateVideoWithFallback(imageUrl, motionDescription, duration, sceneType = 'standard', mood = 'professional', moodIntensity = 5) {
    const maxRetries = 3;
    let lastError;

    // Get mood-specific settings
    const moodSettings = this.getMoodSettings(mood, moodIntensity);

    const sceneSettings = {
      'action': { 
        mode: moodSettings.preferredMode, 
        camera_control: { config: { "pan": Math.min(5, 2 + moodIntensity/2) } } 
      },
      'dialogue': { 
        mode: moodSettings.preferredMode, 
        camera_control: { config: { "tilt": 0 } } 
      },
      'landscape': { 
        mode: 'std', 
        camera_control: { config: { "zoom": Math.max(-3, -1 - moodIntensity/3) } } 
      },
      'emotional': { 
        mode: moodSettings.preferredMode, 
        camera_control: { config: { "zoom": Math.min(6, 2 + moodIntensity/2) } } 
      },
      'standard': { 
        mode: moodSettings.preferredMode, 
        camera_control: { config: { "tilt": 0 } } 
      }
    };

    const settings = sceneSettings[sceneType] || sceneSettings['standard'];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🎬 ${mood} mood video generation attempt ${attempt}/${maxRetries} (${sceneType} scene, intensity: ${moodIntensity}/10)`);
        
        if (attempt === 1) {
          // First try with camera controls and mood enhancement
          return await this.generateVideoWithCameraControl(
            imageUrl, 
            motionDescription, 
            duration, 
            settings.camera_control,
            mood,
            moodIntensity
          );
        } else if (attempt === 2) {
          // Second try with standard generation and mood enhancement
          return await this.generateVideo(imageUrl, motionDescription, duration, '16:9', 'std', mood, moodIntensity);
        } else {
          // Final fallback: simplified prompt with mood but reduced intensity
          const simplifiedMoodIntensity = Math.max(1, moodIntensity - 2);
          const simplePrompt = `Disney animation: ${motionDescription.split(',')[0]} with ${mood} mood`;
          return await this.generateVideo(imageUrl, simplePrompt, duration, '16:9', 'std', mood, simplifiedMoodIntensity);
        }
        
      } catch (error) {
        lastError = error;
        console.error(`❌ ${mood} mood attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 2000;
          console.log(`⏳ Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`${mood} mood video generation failed after ${maxRetries} attempts: ${lastError.message}`);
  }

  // Convert local image for API usage
  async convertLocalImageForKlingAI(localImagePath) {
    try {
      // For Replicate, we need to upload to a public URL first
      if (this.imagekitApiKey && this.imagekitPrivateKey && this.imagekitEndpoint) {
        const tempFileName = `temp_${Date.now()}.png`;
        const tempUrl = await this.uploadToImageKit(localImagePath, tempFileName);
        console.log(`📤 Image uploaded to ImageKit for Replicate: ${tempUrl.substring(0, 50)}...`);
        return tempUrl;
      }
      
      // Fallback: Convert to data URL (may not work with Replicate)
      const imageBuffer = await fs.readFile(localImagePath);
      const base64Data = imageBuffer.toString('base64');
      return `data:image/png;base64,${base64Data}`;
      
    } catch (error) {
      console.error('Error converting local image:', error);
      throw new Error('Failed to convert local image for API usage');
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
        folder: '/temp_animations/'
      });

      return uploadResponse.url;

    } catch (error) {
      console.error('Error uploading to ImageKit:', error);
      throw new Error('Failed to upload to ImageKit');
    }
  }
}

module.exports = new KlingAIService();