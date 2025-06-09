// services/animation/klingAIService.js
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
        // userAgent: 'Disney-Animation-Service/1.0'
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
  }

  // Validate credentials
  validateCredentials() {
    if (!this.accessKey || !this.secretKey) {
      throw new Error('Kling AI credentials are required. Set KLING_ACCESS_KEY and KLING_SECRET_KEY environment variables.');
    }
    return true;
  }

  // Generate video using Replicate (Primary method)
  async generateVideoViaReplicate(imageUrl, prompt, duration = 5, aspectRatio = '16:9', mode = 'std') {
    try {
      if (!this.replicateApiToken) {
        throw new Error('Replicate API token not available');
      }

      console.log('🚀 Attempting video generation via Replicate...');
      console.log(`   Image: ${imageUrl.substring(0, 50)}...`);
      console.log(`   Prompt: ${prompt}`);
      console.log(`   Duration: 10s, Mode: ${mode}`);

      // Choose model based on mode
      const model = mode === 'pro' 
        ? 'kwaivgi/kling-v1.6-pro:03b02153924ef65cd57b7e561f3a4ed66db11c34218d2c70a8af198987edfa3d'
        : 'kwaivgi/kling-v1.6-standard';

      const input = {
        prompt: prompt,
        duration: 10,
        cfg_scale: 0.5,
        start_image: imageUrl,
        aspect_ratio: aspectRatio,
        negative_prompt: ''
      };

      console.log(`🎬 Using Replicate model: ${model.split(':')[0]}`);
      
      const output = await this.replicate.run(model, { input });
      const replicateVideoUrl = output.url().href
      
      console.log('✅ Replicate video generation successful!');
      console.log(`   Video URL: ${replicateVideoUrl}`);

      return {
        success: true,
        videoUrl: replicateVideoUrl,
        duration: 10,
        method: 'replicate'
      };

    } catch (error) {
      console.error('❌ Replicate video generation failed:', error.message);
      throw error;
    }
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
    //   'User-Agent': 'Disney-Animation-Service/1.0'
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
        'User-Agent': 'Disney-Animation-Service/1.0',
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

  // Generate video from image (Updated with Replicate + Fallback)
  async generateVideo(imageUrl, prompt, duration = 5, aspectRatio = '16:9', mode = 'std') {
    try {
      // First attempt: Try Replicate
      try {
        console.log('🎯 Primary attempt: Using Replicate API...');
        return await this.generateVideoViaReplicate(imageUrl, prompt, duration, aspectRatio, mode);
      } catch (replicateError) {
        console.warn('⚠️ Replicate failed, falling back to direct Kling AI API');
        console.warn(`   Replicate error: ${replicateError.message}`);
      }

      // Fallback: Use direct Kling AI API
      console.log('🔄 Fallback: Using direct Kling AI API...');
      return await this.generateVideoViaDirect(imageUrl, prompt, duration, aspectRatio, mode);

    } catch (error) {
      console.error('❌ All video generation methods failed:', error.message);
      throw new Error(`Failed to generate video: ${error.message}`);
    }
  }

  // Generate video via direct Kling AI API (Fallback method)
  async generateVideoViaDirect(imageUrl, prompt, duration = 5, aspectRatio = '16:9', mode = 'std') {
    try {
      console.log('🎬 Generating video with direct Kling AI API...');
      console.log(`   Prompt: ${prompt}`);
      console.log(`   Duration: 10s, Mode: ${mode}`);

    //   const uploadedImageUrl = await this.uploadImage(imageUrl);

      const requestBody = {
        model_name: 'kling-v1-6',
        image: imageUrl,
        prompt: prompt,
        duration: "10",
        mode: mode,
        cfg_scale: 0.5
      };

      const response = await this.makeAuthenticatedRequest('POST', '/videos/image2video', requestBody);

      if (response.code === 0) {
        const taskId = response.data.task_id;
        console.log(`✅ Direct API video generation started with task ID: ${taskId}`);
        
        const result = await this.pollVideoGeneration(taskId);
        return {
          ...result,
          method: 'direct_api'
        };
      } else {
        throw new Error(`Video generation failed: ${response.message}`);
      }

    } catch (error) {
      console.error('❌ Direct API video generation error:', error.message);
      throw new Error(`Failed to generate video via direct API: ${error.message}`);
    }
  }

  // Generate video with camera controls (Updated with Replicate + Fallback)
  async generateVideoWithCameraControl(imageUrl, prompt, duration = 5, cameraControl = {}) {
    try {
      // First attempt: Try Replicate (camera controls may not be supported)
      try {
        console.log('🎯 Primary attempt: Using Replicate API with enhanced prompt...');
        
        // Enhance prompt with camera control descriptions since Replicate may not support camera controls directly
        let enhancedPrompt = prompt;
        if (cameraControl.config && !cameraControl.config.tilt) {
          const cameraDescriptions = {
            'pan': 'smooth panning camera movement',
            'zoom': cameraControl.config.zoom > 0 ? 'slow zoom in camera movement' : 'slow zoom out camera movement',
            'horizontal': 'horizontal camera movement',
            'vertical': 'vertical camera movement'
          };
          
          if (cameraDescriptions[cameraControl.type]) {
            enhancedPrompt += `, ${cameraDescriptions[cameraControl.type]}`;
          }
        }
        
        return await this.generateVideoViaReplicate(imageUrl, enhancedPrompt, duration, '16:9', 'std');
      } catch (replicateError) {
        console.warn('⚠️ Replicate failed, falling back to direct Kling AI API with camera controls');
        console.warn(`   Replicate error: ${replicateError.message}`);
      }

      // Fallback: Use direct Kling AI API with camera controls
      console.log('🔄 Fallback: Using direct Kling AI API with camera controls...');
      return await this.generateVideoWithCameraControlDirect(imageUrl, prompt, duration, cameraControl);

    } catch (error) {
      console.error('❌ All camera control video generation methods failed:', error.message);
      throw new Error(`Failed to generate video with camera control: ${error.message}`);
    }
  }

  // Generate video with camera controls via direct API (Fallback method)
  async generateVideoWithCameraControlDirect(imageUrl, prompt, duration = 5, cameraControl = {}) {
    try {
      console.log('🎥 Generating video with camera controls via direct API...');
      
    //   const uploadedImageUrl = await this.uploadImage(imageUrl);

      const requestBody = {
        model_name: 'kling-v1-6',
        image: imageUrl,
        prompt: prompt,
        duration: "10",
        mode: 'pro',
        cfg_scale: 0.5
      };

      // Add camera control if provided
      if (cameraControl.config && !cameraControl.config.tilt) {
        requestBody.camera_control = cameraControl;
      }

      const response = await this.makeAuthenticatedRequest('POST', '/videos/image2video', requestBody);

      if (response.code === 0) {
        const result = await this.pollVideoGeneration(response.data.task_id);
        return {
          ...result,
          method: 'direct_api_camera'
        };
      } else {
        throw new Error(`Video generation with camera control failed: ${response.message}`);
      }

    } catch (error) {
      console.error('❌ Direct API camera control video generation error:', error.message);
      throw new Error(`Failed to generate video with camera control via direct API: ${error.message}`);
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

  // Enhanced video generation with fallbacks (Updated)
  async generateVideoWithFallback(imageUrl, motionDescription, duration, sceneType = 'standard') {
    const maxRetries = 3;
    let lastError;

    const sceneSettings = {
      'action': { mode: 'pro', camera_control: { config: { "pan": 3 } } },
      'dialogue': { mode: 'pro', camera_control: { config: { "tilt": 0 } } },
      'landscape': { mode: 'std', camera_control: { config: { "zoom": -2 } } },
      'emotional': { mode: 'pro', camera_control: { config: { "zoom": 4 } } },
      'standard': { mode: 'std', camera_control: { config: { "tilt": 0 } } }
    };

    const settings = sceneSettings[sceneType] || sceneSettings['standard'];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🎬 Video generation attempt ${attempt}/${maxRetries} (${sceneType} scene)`);
        
        if (attempt === 1) {
          // First try with camera controls (will use Replicate -> Direct API fallback)
          return await this.generateVideoWithCameraControl(
            imageUrl, 
            motionDescription, 
            duration, 
            settings.camera_control
          );
        } else if (attempt === 2) {
          // Second try with standard generation (will use Replicate -> Direct API fallback)
          return await this.generateVideo(imageUrl, motionDescription, duration, '16:9', 'std');
        } else {
          // Final fallback: simplified prompt with standard generation
          const simplePrompt = `Disney animation: ${motionDescription.split(',')[0]}`;
          return await this.generateVideo(imageUrl, simplePrompt, duration, '16:9', 'std');
        }
        
      } catch (error) {
        lastError = error;
        console.error(`❌ Attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 2000;
          console.log(`⏳ Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Video generation failed after ${maxRetries} attempts: ${lastError.message}`);
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