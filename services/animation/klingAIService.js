// services/animation/klingAIService.js - Enhanced with Fal.ai integration replacing Replicate
const axios = require('axios');
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const FormData = require('form-data');
const path = require('path');
const { fal } = require('@fal-ai/client');

class KlingAIService {
  constructor() {
    this.accessKey = process.env.KLING_ACCESS_KEY;
    this.secretKey = process.env.KLING_SECRET_KEY;
    this.falApiKey = process.env.FAL_API_KEY;
    this.baseURL = 'https://api-singapore.klingai.com/v1';
    
    // Initialize Fal.ai client
    if (this.falApiKey) {
      fal.config({
        credentials: this.falApiKey,
      });
      console.log('✅ Fal.ai client initialized');
    } else {
      console.warn('⚠️ Fal.ai API key not found. Please set FAL_API_KEY environment variable.');
    }
    
    if (!this.accessKey || !this.secretKey) {
      console.warn('⚠️ Kling AI credentials not found. Please set KLING_ACCESS_KEY and KLING_SECRET_KEY environment variables.');
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

  // Generate video using Fal.ai with mood support (Primary method - replacing Replicate)
  async generateVideoViaFalAI(imageUrl, prompt, duration = 5, aspectRatio = '16:9', mode = 'std', mood = 'professional', moodIntensity = 5) {
    try {
      if (!this.falApiKey) {
        throw new Error('Fal.ai API key not available');
      }

      console.log(`🚀 Attempting ${mood} mood video generation via Fal.ai (intensity: ${moodIntensity}/10)...`);
      console.log(`   Image: ${imageUrl.substring(0, 50)}...`);
      console.log(`   Prompt: ${prompt}`);
      console.log(`   Duration: 10s, Mode: ${mode}, Mood: ${mood}`);

      // Get mood-specific settings
      const moodSettings = this.getMoodSettings(mood, moodIntensity);

      // Choose the appropriate Fal.ai model endpoint based on mode
      const modelEndpoint = mode === 'pro' 
        ? 'fal-ai/kling-video/v2.1/pro/image-to-video'
        : 'fal-ai/kling-video/v2.1/standard/image-to-video';

      // Enhance prompt with mood-specific motion characteristics
      const moodEnhancedPrompt = this.enhancePromptWithMoodCharacteristics(prompt, mood, moodSettings);

      // Prepare the request input
      const input = {
        prompt: moodEnhancedPrompt,
        image_url: imageUrl,
        duration: "10", // Fal.ai uses string format
        aspect_ratio: aspectRatio,
        cfg_scale: moodSettings.cfg_scale,
        negative_prompt: this.getMoodSpecificNegativePrompt(mood)
      };

      console.log(`🎬 Using Fal.ai model: ${modelEndpoint} with ${mood} mood optimization`);
      
      // Submit the request and wait for completion
      const result = await fal.subscribe(modelEndpoint, {
        input: input,
        logs: true,
        onQueueUpdate: (update) => {
          if (update.status === "IN_PROGRESS") {
            console.log(`   Fal.ai progress: ${update.status}`);
            if (update.logs) {
              update.logs.map((log) => log.message).forEach(message => {
                if (message) console.log(`   ${message}`);
              });
            }
          } else {
            console.log(`   Fal.ai status: ${update.status}`);
          }
        },
      });

      if (!result.data || !result.data.video || !result.data.video.url) {
        throw new Error('Invalid response from Fal.ai - no video URL received');
      }

      const falVideoUrl = result.data.video.url;
      
      console.log(`✅ ${mood} mood Fal.ai video generation successful!`);
      console.log(`   Video URL: ${falVideoUrl}`);

      return {
        success: true,
        videoUrl: falVideoUrl,
        duration: 10,
        method: 'fal-ai',
        mood: mood,
        moodIntensity: moodIntensity,
        requestId: result.requestId
      };

    } catch (error) {
      console.error(`❌ ${mood} mood Fal.ai video generation failed:`, error.message);
      throw error;
    }
  }

  // Enhanced method for queue-based processing (optional for async workflows)
  async generateVideoViaFalAIQueue(imageUrl, prompt, duration = 5, aspectRatio = '16:9', mode = 'std', mood = 'professional', moodIntensity = 5, webhookUrl = null) {
    try {
      if (!this.falApiKey) {
        throw new Error('Fal.ai API key not available');
      }

      console.log(`🔄 Submitting ${mood} mood video generation to Fal.ai queue...`);

      // Get mood-specific settings
      const moodSettings = this.getMoodSettings(mood, moodIntensity);

      const modelEndpoint = mode === 'pro' 
        ? 'fal-ai/kling-video/v2.1/pro/image-to-video'
        : 'fal-ai/kling-video/v2.1/standard/image-to-video';

      const moodEnhancedPrompt = this.enhancePromptWithMoodCharacteristics(prompt, mood, moodSettings);

      const input = {
        prompt: moodEnhancedPrompt,
        image_url: imageUrl,
        duration: "10",
        aspect_ratio: aspectRatio,
        cfg_scale: moodSettings.cfg_scale,
        negative_prompt: this.getMoodSpecificNegativePrompt(mood)
      };

      // Submit to queue
      const submission = await fal.queue.submit(modelEndpoint, {
        input: input,
        webhookUrl: webhookUrl
      });

      console.log(`✅ ${mood} mood job submitted to Fal.ai queue with ID: ${submission.request_id}`);

      return {
        success: true,
        requestId: submission.request_id,
        mood: mood,
        moodIntensity: moodIntensity,
        method: 'fal-ai-queue'
      };

    } catch (error) {
      console.error(`❌ ${mood} mood Fal.ai queue submission failed:`, error.message);
      throw error;
    }
  }

  // Poll Fal.ai queue status
  async pollFalAIQueueStatus(requestId, modelEndpoint = 'fal-ai/kling-video/v2.1/standard/image-to-video') {
    try {
      const status = await fal.queue.status(modelEndpoint, {
        requestId: requestId,
        logs: true,
      });

      return status;
    } catch (error) {
      console.error('❌ Error polling Fal.ai queue status:', error.message);
      throw error;
    }
  }

  // Get result from Fal.ai queue
  async getFalAIQueueResult(requestId, modelEndpoint = 'fal-ai/kling-video/v2.1/standard/image-to-video') {
    try {
      const result = await fal.queue.result(modelEndpoint, {
        requestId: requestId
      });

      if (!result.data || !result.data.video || !result.data.video.url) {
        throw new Error('Invalid response from Fal.ai - no video URL received');
      }

      return {
        success: true,
        videoUrl: result.data.video.url,
        duration: 10,
        method: 'fal-ai-queue',
        requestId: result.requestId
      };

    } catch (error) {
      console.error('❌ Error getting Fal.ai queue result:', error.message);
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

    const baseNegative = 'blur, distort, low quality, bad anatomy, watermark, text, signature';
    const moodSpecific = baseMoodNegatives[mood] || baseMoodNegatives['professional'];
    
    return `${baseNegative}, ${moodSpecific}`;
  }

  // Generate JWT token for authentication (Direct Kling AI API)
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

  // UPDATED: Generate video from image with mood support (now uses Fal.ai as primary)
  async generateVideo(imageUrl, prompt, duration = 5, aspectRatio = '16:9', mode = 'std', mood = 'professional', moodIntensity = 5) {
    try {
      // First attempt: Try Fal.ai with mood support
      try {
        console.log(`🎯 Primary attempt: Using Fal.ai API with ${mood} mood...`);
        return await this.generateVideoViaFalAI(imageUrl, prompt, duration, aspectRatio, mode, mood, moodIntensity);
      } catch (falError) {
        console.warn(`⚠️ Fal.ai failed for ${mood} mood, falling back to direct Kling AI API`);
        console.warn(`   Fal.ai error: ${falError.message}`);
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

  // Download video
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

  // UPDATED: Enhanced video generation with mood-aware fallbacks (now uses Fal.ai as primary)
  async generateVideoWithFallback(imageUrl, motionDescription, duration, sceneType = 'standard', mood = 'professional', moodIntensity = 5) {
    const maxRetries = 3;
    let lastError;

    // Get mood-specific settings
    const moodSettings = this.getMoodSettings(mood, moodIntensity);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🎬 ${mood} mood video generation attempt ${attempt}/${maxRetries} (${sceneType} scene, intensity: ${moodIntensity}/10)`);
        
        if (attempt === 1) {
          // First try with Fal.ai and mood enhancement
          return await this.generateVideoViaFalAI(
            imageUrl, 
            motionDescription, 
            duration, 
            '16:9',
            'std',
            mood,
            moodIntensity
          );
        } else if (attempt === 2) {
          // Second try with direct Kling AI API
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
      // For Fal.ai, we can upload the file directly using their storage service
      if (this.falApiKey) {
        try {
          console.log('📤 Uploading image to Fal.ai storage...');
          
          // Read the file
          const fileBuffer = await fs.readFile(localImagePath);
          const fileName = path.basename(localImagePath);
          
          // Create a File object (simulating browser File API in Node.js)
          const file = {
            buffer: fileBuffer,
            name: fileName,
            type: 'image/png'
          };
          
          // Upload to Fal.ai storage
          const url = await fal.storage.upload(fileBuffer, {
            fileName: fileName,
            contentType: 'image/png'
          });
          
          console.log(`✅ Image uploaded to Fal.ai storage: ${url.substring(0, 50)}...`);
          return url;
          
        } catch (uploadError) {
          console.warn('⚠️ Fal.ai upload failed, falling back to base64:', uploadError.message);
        }
      }
      
      // Fallback: Convert to base64 data URI
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