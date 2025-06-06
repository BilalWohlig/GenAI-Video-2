// controllers/animation/generateAnimation.js
const express = require('express')
const router = express.Router()
const __constants = require('../../config/constants')
const validationOfAPI = require('../../middlewares/validation')
const animationService = require('../../services/animation/animationService')
// const animationService = require('../../services/animation/animationService2')
const Animation = require('../../mongooseSchema/Animation')
const axios = require('axios')

/**
 * @namespace -ANIMATION-MODULE-
 * @description API's related to AI Animation Generation module.
 */

/**
 * @memberof -ANIMATION-module-
 * @name generateAnimation
 * @path {POST} /api/animation/generateAnimation
 * @description Generate a complete Disney/Pixar style animation from news article
 * @body {string} article - The news article content to convert to animation
 * @body {number} sceneCount - Number of scenes to generate (1-20)
 * @response {string} ContentType=application/json - Response content type.
 * @response {object} data - Animation generation result with video URL and details
 * @code {200} Success - Animation generated successfully
 * @code {400} Bad Request - Invalid input parameters
 * @code {500} Server Error - Animation generation failed
 * @author AI Animation Service, 2025
 */
const generateAnimationValidationSchema = {
  type: 'object',
  required: true,
  properties: {
    article: {
      type: 'string',
      required: true,
      minLength: 100,
      maxLength: 10000
    },
    sceneCount: {
      type: 'number',
      required: true,
      minimum: 1,
      maximum: 20
    }
  }
}

const generateAnimationValidation = (req, res, next) => {
  return validationOfAPI(req, res, next, generateAnimationValidationSchema, 'body')
}

const generateAnimation = async (req, res) => {
  try {
    const { article, sceneCount } = req.body

    // Validate article content
    if (!article || article.trim().length < 100) {
      return res.sendJson({
        type: __constants.RESPONSE_MESSAGES.INVALID_REQUEST,
        err: ['Article content must be at least 100 characters long']
      })
    }

    // Check if similar animation already exists (optional optimization)
    const existingAnimation = await Animation.findOne({
      article: article,
      sceneCount: sceneCount,
      status: 'completed',
      isActive: true
    }).sort({ createdAt: -1 })

    if (existingAnimation) {
      return res.sendJson({
        type: __constants.RESPONSE_MESSAGES.SUCCESS,
        data: {
          message: 'Similar animation found in database',
          animationId: existingAnimation._id,
          videoUrl: existingAnimation.videoUrl,
          title: existingAnimation.title,
          fromCache: true
        }
      })
    }

    // Start animation generation process
    console.log(`Starting animation generation for article: ${article.substring(0, 100)}...`)
    
    const result = await animationService.generateAnimation(article, sceneCount)

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: {
        message: 'Animation generated successfully',
        ...result
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

/**
 * @memberof -ANIMATION-module-
 * @name getAnimationStatus
 * @path {GET} /api/animation/getAnimationStatus/:animationId
 * @description Get the status and details of an animation by ID
 * @params {string} animationId - The animation ID to check status
 * @response {object} data - Animation status and details
 * @code {200} Success - Animation status retrieved
 * @code {404} Not Found - Animation not found
 */
const getAnimationStatusValidationSchema = {
  type: 'object',
  required: true,
  properties: {
    animationId: {
      type: 'string',
      required: true,
      minLength: 24,
      maxLength: 24
    }
  }
}

const getAnimationStatusValidation = (req, res, next) => {
  return validationOfAPI(req, res, next, getAnimationStatusValidationSchema, 'params')
}

const getAnimationStatus = async (req, res) => {
  try {
    const { animationId } = req.params

    const animation = await Animation.findById(animationId)

    if (!animation) {
      return res.sendJson({
        type: __constants.RESPONSE_MESSAGES.NOT_FOUND,
        err: ['Animation not found']
      })
    }

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: {
        animationId: animation._id,
        title: animation.title,
        theme: animation.theme,
        status: animation.status,
        sceneCount: animation.sceneCount,
        videoUrl: animation.videoUrl,
        processingTime: animation.processingTime,
        generatedAt: animation.generatedAt,
        characters: animation.characters,
        scenes: animation.scenes.map(scene => ({
          sceneNumber: scene.sceneNumber,
          description: scene.description,
          location: scene.location,
          mood: scene.mood,
          duration: scene.duration
        }))
      }
    })

  } catch (err) {
    console.error('Error in getAnimationStatus API:', err)
    
    return res.sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.message || 'Failed to get animation status'
    })
  }
}

/**
 * @memberof -ANIMATION-module-
 * @name getAllAnimations
 * @path {GET} /api/animation/getAllAnimations
 * @description Get all animations with pagination and filtering
 * @query {number} page - Page number (default: 1)
 * @query {number} limit - Items per page (default: 10, max: 50)
 * @query {string} status - Filter by status (processing, completed, failed)
 * @query {string} search - Search in title and theme
 * @response {object} data - Paginated list of animations
 * @code {200} Success - Animations retrieved successfully
 */
const getAllAnimationsValidationSchema = {
  type: 'object',
  required: false,
  properties: {
    page: {
      type: 'number',
      required: false,
      minimum: 1
    },
    limit: {
      type: 'number',
      required: false,
      minimum: 1,
      maximum: 50
    },
    status: {
      type: 'string',
      required: false,
      enum: ['processing', 'completed', 'failed']
    },
    search: {
      type: 'string',
      required: false,
      minLength: 2,
      maxLength: 100
    }
  }
}

const getAllAnimationsValidation = (req, res, next) => {
  return validationOfAPI(req, res, next, getAllAnimationsValidationSchema, 'query')
}

const getAllAnimations = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = Math.min(parseInt(req.query.limit) || 10, 50)
    const skip = (page - 1) * limit
    const { status, search } = req.query

    // Build query
    const query = { isActive: true }
    
    if (status) {
      query.status = status
    }

    if (search) {
      query.$text = { $search: search }
    }

    // Execute query with pagination
    const [animations, totalCount] = await Promise.all([
      Animation.find(query)
        .select('title theme status sceneCount videoUrl processingTime generatedAt')
        .sort({ generatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Animation.countDocuments(query)
    ])

    const totalPages = Math.ceil(totalCount / limit)

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: {
        animations,
        pagination: {
          currentPage: page,
          totalPages,
          totalCount,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      }
    })

  } catch (err) {
    console.error('Error in getAllAnimations API:', err)
    
    return res.sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.message || 'Failed to get animations'
    })
  }
}

/**
 * @memberof -ANIMATION-module-
 * @name deleteAnimation
 * @path {DELETE} /api/animation/deleteAnimation/:animationId
 * @description Soft delete an animation by ID
 * @params {string} animationId - The animation ID to delete
 * @response {object} data - Deletion confirmation
 * @code {200} Success - Animation deleted successfully
 * @code {404} Not Found - Animation not found
 */
const deleteAnimationValidationSchema = {
  type: 'object',
  required: true,
  properties: {
    animationId: {
      type: 'string',
      required: true,
      minLength: 24,
      maxLength: 24
    }
  }
}

const deleteAnimationValidation = (req, res, next) => {
  return validationOfAPI(req, res, next, deleteAnimationValidationSchema, 'params')
}

const deleteAnimation = async (req, res) => {
  try {
    const { animationId } = req.params

    const animation = await Animation.findByIdAndUpdate(
      animationId,
      { isActive: false },
      { new: true }
    )

    if (!animation) {
      return res.sendJson({
        type: __constants.RESPONSE_MESSAGES.NOT_FOUND,
        err: ['Animation not found']
      })
    }

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: {
        message: 'Animation deleted successfully',
        animationId: animation._id
      }
    })

  } catch (err) {
    console.error('Error in deleteAnimation API:', err)
    
    return res.sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.message || 'Failed to delete animation'
    })
  }
}

/**
 * @memberof -ANIMATION-module-
 * @name generateAnimationAsync
 * @path {POST} /api/animation/generateAnimationAsync
 * @description Start async animation generation and return immediately with job ID
 * @body {string} article - The news article content to convert to animation
 * @body {number} sceneCount - Number of scenes to generate (1-20)
 * @body {string} callbackUrl - Optional webhook URL for completion notification
 * @response {object} data - Job ID for tracking async generation
 * @code {202} Accepted - Animation generation started
 * @code {400} Bad Request - Invalid input parameters
 */
const generateAnimationAsyncValidationSchema = {
  type: 'object',
  required: true,
  properties: {
    article: {
      type: 'string',
      required: true,
      minLength: 100,
      maxLength: 10000
    },
    sceneCount: {
      type: 'number',
      required: true,
      minimum: 1,
      maximum: 20
    },
    callbackUrl: {
      type: 'string',
      required: false,
      pattern: '^https?://.+'
    }
  }
}

const generateAnimationAsyncValidation = (req, res, next) => {
  return validationOfAPI(req, res, next, generateAnimationAsyncValidationSchema, 'body')
}

const generateAnimationAsync = async (req, res) => {
  try {
    const { article, sceneCount, callbackUrl } = req.body

    // Create initial animation record
    const animation = new Animation({
      title: 'Processing...',
      theme: 'Processing...',
      article: article,
      sceneCount: sceneCount,
      characters: [],
      scenes: [],
      videoUrl: '',
      status: 'processing',
      processingTime: 0
    })

    await animation.save()

    // Start async processing
    processAnimationAsync(animation._id, article, sceneCount, callbackUrl)
      .catch(error => {
        console.error('Async animation processing failed:', error)
        // Update status to failed
        Animation.findByIdAndUpdate(animation._id, { status: 'failed' }).exec()
      })

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.ACCEPTED,
      data: {
        message: 'Animation generation started',
        jobId: animation._id,
        status: 'processing',
        estimatedTime: sceneCount * 2 * 60 * 1000 // Rough estimate: 2 minutes per scene
      }
    })

  } catch (err) {
    console.error('Error in generateAnimationAsync API:', err)
    
    return res.sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.message || 'Failed to start animation generation'
    })
  }
}

/**
 * @memberof -ANIMATION-module-
 * @name getAnimationsByStatus
 * @path {GET} /api/animation/getAnimationsByStatus/:status
 * @description Get animations filtered by specific status
 * @params {string} status - Status to filter by (processing, completed, failed)
 * @query {number} page - Page number (default: 1)
 * @query {number} limit - Items per page (default: 10)
 * @response {object} data - Filtered animations list
 * @code {200} Success - Animations retrieved successfully
 */
const getAnimationsByStatusParamsValidationSchema = {
  type: 'object',
  required: true,
  properties: {
    status: {
      type: 'string',
      required: true,
      enum: ['processing', 'completed', 'failed']
    }
  }
}

const getAnimationsByStatusQueryValidationSchema = {
  type: 'object',
  required: false,
  properties: {
    page: {
      type: 'number',
      required: false,
      minimum: 1
    },
    limit: {
      type: 'number',
      required: false,
      minimum: 1,
      maximum: 50
    }
  }
}

const getAnimationsByStatusValidation = (req, res, next) => {
  // First validate params
  return validationOfAPI(req, res, (paramsErr) => {
    if (paramsErr) return;
    // Then validate query
    validationOfAPI(req, res, next, getAnimationsByStatusQueryValidationSchema, 'query');
  }, getAnimationsByStatusParamsValidationSchema, 'params');
}

const getAnimationsByStatus = async (req, res) => {
  try {
    const { status } = req.params
    const page = parseInt(req.query.page) || 1
    const limit = Math.min(parseInt(req.query.limit) || 10, 50)
    const skip = (page - 1) * limit

    const [animations, totalCount] = await Promise.all([
      Animation.find({ status, isActive: true })
        .select('title theme sceneCount videoUrl processingTime generatedAt')
        .sort({ generatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Animation.countDocuments({ status, isActive: true })
    ])

    const totalPages = Math.ceil(totalCount / limit)

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: {
        status,
        animations,
        pagination: {
          currentPage: page,
          totalPages,
          totalCount,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      }
    })

  } catch (err) {
    console.error('Error in getAnimationsByStatus API:', err)
    
    return res.sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.message || 'Failed to get animations by status'
    })
  }
}

/**
 * @memberof -ANIMATION-module-
 * @name getAnimationStats
 * @path {GET} /api/animation/getAnimationStats
 * @description Get animation generation statistics
 * @response {object} data - Animation statistics
 * @code {200} Success - Statistics retrieved successfully
 */
const getAnimationStatsValidationSchema = {
  type: 'object',
  required: false,
  properties: {}
}

const getAnimationStatsValidation = (req, res, next) => {
  return validationOfAPI(req, res, next, getAnimationStatsValidationSchema, 'query')
}

const getAnimationStats = async (req, res) => {
  try {
    const [
      totalAnimations,
      processingAnimations,
      completedAnimations,
      failedAnimations,
      avgProcessingTime,
      recentAnimations
    ] = await Promise.all([
      Animation.countDocuments({ isActive: true }),
      Animation.countDocuments({ status: 'processing', isActive: true }),
      Animation.countDocuments({ status: 'completed', isActive: true }),
      Animation.countDocuments({ status: 'failed', isActive: true }),
      Animation.aggregate([
        { $match: { status: 'completed', isActive: true, processingTime: { $gt: 0 } } },
        { $group: { _id: null, avgTime: { $avg: '$processingTime' } } }
      ]),
      Animation.find({ isActive: true })
        .select('title status generatedAt processingTime')
        .sort({ generatedAt: -1 })
        .limit(5)
        .lean()
    ])

    const averageProcessingTime = avgProcessingTime.length > 0 
      ? Math.round(avgProcessingTime[0].avgTime) 
      : 0

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: {
        total: totalAnimations,
        processing: processingAnimations,
        completed: completedAnimations,
        failed: failedAnimations,
        successRate: totalAnimations > 0 
          ? Math.round((completedAnimations / totalAnimations) * 100) 
          : 0,
        averageProcessingTime: averageProcessingTime,
        averageProcessingTimeFormatted: `${(averageProcessingTime / 1000 / 60).toFixed(1)} minutes`,
        recentAnimations
      }
    })

  } catch (err) {
    console.error('Error in getAnimationStats API:', err)
    
    return res.sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.message || 'Failed to get animation statistics'
    })
  }
}

/**
 * @memberof -ANIMATION-module-
 * @name updateAnimationStatus
 * @path {PUT} /api/animation/updateAnimationStatus/:animationId
 * @description Update animation status (for internal use)
 * @params {string} animationId - The animation ID to update
 * @body {string} status - New status (processing, completed, failed)
 * @body {string} videoUrl - Video URL (if completed)
 * @body {number} processingTime - Processing time in milliseconds
 * @response {object} data - Update confirmation
 * @code {200} Success - Status updated successfully
 * @code {404} Not Found - Animation not found
 */
const updateAnimationStatusParamsValidationSchema = {
  type: 'object',
  required: true,
  properties: {
    animationId: {
      type: 'string',
      required: true,
      minLength: 24,
      maxLength: 24
    }
  }
}

const updateAnimationStatusBodyValidationSchema = {
  type: 'object',
  required: true,
  properties: {
    status: {
      type: 'string',
      required: true,
      enum: ['processing', 'completed', 'failed']
    },
    videoUrl: {
      type: 'string',
      required: false
    },
    processingTime: {
      type: 'number',
      required: false,
      minimum: 0
    },
    title: {
      type: 'string',
      required: false
    },
    theme: {
      type: 'string',
      required: false
    }
  }
}

const updateAnimationStatusValidation = (req, res, next) => {
  // First validate params
  return validationOfAPI(req, res, (paramsErr) => {
    if (paramsErr) return;
    // Then validate body
    validationOfAPI(req, res, next, updateAnimationStatusBodyValidationSchema, 'body');
  }, updateAnimationStatusParamsValidationSchema, 'params');
}

const updateAnimationStatus = async (req, res) => {
  try {
    const { animationId } = req.params
    const { status, videoUrl, processingTime, title, theme } = req.body

    const updateData = { status }
    
    if (videoUrl) updateData.videoUrl = videoUrl
    if (processingTime) updateData.processingTime = processingTime
    if (title) updateData.title = title
    if (theme) updateData.theme = theme

    const animation = await Animation.findByIdAndUpdate(
      animationId,
      updateData,
      { new: true }
    )

    if (!animation) {
      return res.sendJson({
        type: __constants.RESPONSE_MESSAGES.NOT_FOUND,
        err: ['Animation not found']
      })
    }

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: {
        message: 'Animation status updated successfully',
        animationId: animation._id,
        status: animation.status,
        videoUrl: animation.videoUrl
      }
    })

  } catch (err) {
    console.error('Error in updateAnimationStatus API:', err)
    
    return res.sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.message || 'Failed to update animation status'
    })
  }
}

// Async processing function
const processAnimationAsync = async (animationId, article, sceneCount, callbackUrl) => {
  const startTime = Date.now()
  
  try {
    console.log(`Starting async animation generation for ID: ${animationId}`)
    
    const result = await animationService.generateAnimation(article, sceneCount)
    const processingTime = Date.now() - startTime

    // Update animation record with results
    await Animation.findByIdAndUpdate(animationId, {
      title: result.title,
      videoUrl: result.videoUrl,
      status: 'completed',
      processingTime: processingTime
    })

    console.log(`Async animation generation completed for ID: ${animationId}`)

    // Send webhook notification if provided
    if (callbackUrl) {
      try {
        await axios.post(callbackUrl, {
          jobId: animationId,
          status: 'completed',
          result: result,
          processingTime: processingTime
        }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json'
          }
        })
      } catch (webhookError) {
        console.error('Failed to send webhook notification:', webhookError)
      }
    }

  } catch (error) {
    console.error(`Async animation generation failed for ID: ${animationId}:`, error)
    
    // Update status to failed
    await Animation.findByIdAndUpdate(animationId, {
      status: 'failed',
      processingTime: Date.now() - startTime
    })

    // Send failure webhook if provided
    if (callbackUrl) {
      try {
        await axios.post(callbackUrl, {
          jobId: animationId,
          status: 'failed',
          error: error.message,
          processingTime: Date.now() - startTime
        }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json'
          }
        })
      } catch (webhookError) {
        console.error('Failed to send failure webhook notification:', webhookError)
      }
    }
  }
}

// Register routes with proper validation
router.post('/generateAnimation', generateAnimationValidation, generateAnimation)
router.post('/generateAnimationAsync', generateAnimationAsyncValidation, generateAnimationAsync)
router.get('/getAnimationStatus/:animationId', getAnimationStatusValidation, getAnimationStatus)
router.get('/getAllAnimations', getAllAnimationsValidation, getAllAnimations)
router.get('/getAnimationsByStatus/:status', getAnimationsByStatusValidation, getAnimationsByStatus)
router.get('/getAnimationStats', getAnimationStatsValidation, getAnimationStats)
router.put('/updateAnimationStatus/:animationId', updateAnimationStatusValidation, updateAnimationStatus)
router.delete('/deleteAnimation/:animationId', deleteAnimationValidation, deleteAnimation)

module.exports = router