// mongooseSchema/Animation.js
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

module.exports = mongoose.model('Animation', animationSchema)