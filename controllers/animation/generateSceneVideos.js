// controllers/animation/generateAnimation.js
const express = require('express')
const router = express.Router()
const __constants = require('../../config/constants')
const validationOfAPI = require('../../middlewares/validation')
const animationService = require('../../services/animation/animationService')
const Animation = require('../../mongooseSchema/Animation')
const axios = require('axios')
const KlingAI = require('../../services/animation/klingAIService');
const OpenAI = require('openai');
const fs = require('fs').promises;
const fsSync = require('fs');
const { toFile } = require('openai');
const path = require('path')
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
const imagekitApiKey = process.env.IMAGEKIT_API_KEY;
const imagekitPrivateKey = process.env.IMAGEKIT_PRIVATE_KEY;
const imagekitEndpoint = process.env.IMAGEKIT_ENDPOINT;
const workingDir = path.join(__dirname, '../../temp');
const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');
const { v4: uuidv4 } = require('uuid');

const generateSceneVideosValidationSchema = {
  type: 'object',
  required: true,
  properties: {
  }
}

const generateSceneVideosValidation = (req, res, next) => {
  return validationOfAPI(req, res, next, generateSceneVideosValidationSchema, 'body')
}

const MotionDescriptionSchema = z.object({
    motionDescription: z.string().max(200)
  });
  

const generateSceneVideos = async (req, res) => {
  try {
    const sceneVideos = [];
    const { sceneImages } = req.body

    for (const scene of sceneImages) {
        try {
          console.log(`🎥 Generating video for scene ${scene.sceneNumber}`);
  
          // Generate motion description using GPT-4 with structured response
          const motionSystemPrompt = `You are a Disney animation director. Create concise motion descriptions for video generation that capture Disney-style movement and camera work.`;
          
          const motionUserPrompt = `Create smooth camera movement and character animation for this Disney/Pixar scene:
          ${scene.description}
          
          Consider:
          - Natural character movements
          - Smooth camera transitions  
          - Disney-style animation principles
          - Scene type: ${scene.sceneType}
          - Scene duration: ${scene.duration} seconds
          
          Provide a concise motion description (max 200 characters) suitable for AI video generation.`;
  
          const motionResponse = await openai.responses.parse({
            model: "gpt-4o-2024-08-06",
            input: [
              { role: "system", content: motionSystemPrompt },
              { role: "user", content: motionUserPrompt }
            ],
            text: {
              format: zodTextFormat(MotionDescriptionSchema, "motion")
            }
          });
  
          const motionDescription = motionResponse.output_parsed.motionDescription;
  
          // Enhance prompt for Disney quality
          const enhancedPrompt = enhancePromptForDisney(motionDescription, scene);
  
          // Convert local image file to a format APIs can use
          const imageUrl = await convertLocalImageForKlingAI(scene.image);
  
          // Generate video using Kling AI with fallback strategy
          const result = await KlingAI.generateVideoWithFallback(
            imageUrl,
            enhancedPrompt,
            scene.duration,
            scene.sceneType
          );
  
          // Download video locally
          const videoPath = path.join(workingDir, 'videos', `scene_${scene.sceneNumber}_${uuidv4()}.mp4`);
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

    // return sceneVideos;
    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: {
        message: 'Animation generated successfully',
        sceneVideos: sceneVideos
      }
    })

  } catch (err) {
    console.error('Error in generateAnimation API:', err)
    
    return res.sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.message || 'Failed to generate animation'
    })
  }
}

function enhancePromptForDisney(basePrompt, sceneContext) {
    const disneyKeywords = [
      'Disney/Pixar 3D animation style',
      'vibrant colors',
      'smooth character animation',
      'cinematic lighting',
      'professional quality',
      'engaging expressions',
      'magical atmosphere'
    ];

    const cameraKeywords = {
      'emotional': 'close-up shot with gentle camera movement',
      'action': 'dynamic camera following the action',
      'landscape': 'wide establishing shot with slow pan',
      'dialogue': 'shot-reverse-shot conversation style',
      'standard': 'smooth camera movement'
    };

    let enhanced = basePrompt;
    enhanced += `, ${disneyKeywords.join(', ')}`;
    
    if (sceneContext.mood) {
      enhanced += `, ${sceneContext.mood} mood`;
    }
    
    if (sceneContext.sceneType && cameraKeywords[sceneContext.sceneType]) {
      enhanced += `, ${cameraKeywords[sceneContext.sceneType]}`;
    }

    return enhanced;
  }

const convertLocalImageForKlingAI = async(localImagePath) => {
try {
    // Option 1: Upload to ImageKit temporarily and return URL
    if (imagekitApiKey && imagekitPrivateKey && imagekitEndpoint) {
        const tempFileName = `temp_${uuidv4()}.png`;
        const tempUrl = await uploadToImageKit(localImagePath, tempFileName);
        return tempUrl;
    }
    
    // Option 2: Convert to data URL (base64)
    const imageBuffer = await fs.readFile(localImagePath);
    const base64Data = imageBuffer.toString('base64');
    return `${base64Data}`;
    // return `data:image/png;base64,${base64Data}`;
    
} catch (error) {
    console.error('Error converting local image for Kling AI:', error);
    throw new Error('Failed to convert local image for Kling AI');
}
}
const uploadToImageKit = async(filePath, fileName) => {
    try {
      if (!imagekitApiKey || !imagekitPrivateKey || !imagekitEndpoint) {
        throw new Error('ImageKit configuration missing');
      }

      const ImageKit = require('imagekit');
      
      const imagekit = new ImageKit({
        publicKey: imagekitApiKey,
        privateKey: imagekitPrivateKey,
        urlEndpoint: imagekitEndpoint
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



// Register routes with proper validation
router.post('/generateSceneVideos', generateSceneVideosValidation, generateSceneVideos)

module.exports = router