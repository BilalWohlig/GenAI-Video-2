// mongooseSchema/Animation.js - Updated with storage information
const mongoose = require('mongoose')
const Schema = mongoose.Schema
const timestamps = require('mongoose-timestamp-plugin')

const characterSchema = new Schema({
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  personality: {
    type: String,
    required: true
  },
  role: {
    type: String,
    required: true
  }
}, { _id: false })

const sceneSchema = new Schema({
  sceneNumber: {
    type: Number,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  characters: [{
    type: String
  }],
  location: {
    type: String,
    required: true
  },
  mood: {
    type: String,
    required: true
  },
  cameraAngle: {
    type: String,
    required: true
  },
  narration: {
    type: String,
    required: true
  },
  duration: {
    type: Number,
    default: 5
  }
}, { _id: false })

// Add storage schema for tracking where videos are stored
const storageSchema = new Schema({
  type: {
    type: String,
    enum: ['local', 'gcs', 's3', 'azure'],
    required: true,
    default: 'local'
  },
  bucketName: {
    type: String,
    required: false // Only required for cloud storage
  },
  fileName: {
    type: String,
    required: false // Only required for cloud storage
  },
  publicUrl: {
    type: String,
    required: true
  },
  isPublic: {
    type: Boolean,
    default: false
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  },
  uploadError: {
    type: String,
    required: false // Only set if upload failed
  },
  fileSize: {
    type: Number,
    required: false // File size in bytes
  },
  contentType: {
    type: String,
    default: 'video/mp4'
  }
}, { _id: false })

const animationSchema = new Schema({
  title: {
    type: String,
    required: true
  },
  theme: {
    type: String,
    required: true
  },
  article: {
    type: String,
    required: true
  },
  sceneCount: {
    type: Number,
    required: true,
    min: 1,
    max: 20
  },
  characters: [characterSchema],
  scenes: [sceneSchema],
  videoUrl: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['processing', 'completed', 'failed'],
    default: 'processing'
  },
  processingTime: {
    type: Number, // in milliseconds
    required: true
  },
  generatedAt: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Add storage information
  storage: {
    type: storageSchema,
    required: false // Optional for backward compatibility
  },
  // Add mood and country context information
  overallMood: {
    type: String,
    required: false
  },
  moodProgression: [{
    type: String
  }],
  countryContext: {
    primaryCountry: String,
    primaryCity: String,
    culturalContext: String,
    architecturalStyle: String,
    demographicNotes: String,
    languageContext: String
  }
})

const timestampsAppendObj = {
  createdName: 'createdAt',
  updatedName: 'updatedAt',
  disableCreated: false,
  disableUpdated: false
}

animationSchema.plugin(timestamps, timestampsAppendObj)

// Add indexes for better query performance
animationSchema.index({ status: 1 })
animationSchema.index({ generatedAt: -1 })
animationSchema.index({ title: 'text', theme: 'text' })
animationSchema.index({ 'storage.type': 1 })
animationSchema.index({ 'storage.isPublic': 1 })
animationSchema.index({ overallMood: 1 })

// Add virtual for public access URL
animationSchema.virtual('publicVideoUrl').get(function() {
  if (this.storage && this.storage.isPublic) {
    return this.storage.publicUrl;
  }
  return this.videoUrl;
});

// Add method to check if video is stored in cloud
animationSchema.methods.isCloudStored = function() {
  return this.storage && ['gcs', 's3', 'azure'].includes(this.storage.type);
};

// Add method to get storage details
animationSchema.methods.getStorageInfo = function() {
  if (!this.storage) {
    return {
      type: 'local',
      isPublic: false,
      url: this.videoUrl
    };
  }
  
  return {
    type: this.storage.type,
    isPublic: this.storage.isPublic,
    url: this.storage.publicUrl,
    bucketName: this.storage.bucketName,
    fileName: this.storage.fileName,
    uploadedAt: this.storage.uploadedAt,
    fileSize: this.storage.fileSize
  };
};

module.exports = mongoose.model('Animation', animationSchema)