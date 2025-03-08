const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const history = require('./history');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
const helmet = require('helmet');

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "https://generativelanguage.googleapis.com"],
    },
  },
}));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-API-Key']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public', {
  maxAge: '1h',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Global rate limiter
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Configure multer for handling file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Use the history module to ensure uploads directory exists
    const uploadDir = history.ensureUploadsDirectory();
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter to accept only images
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'), false);
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Initialize Google Generative AI with a placeholder - actual API key will be provided by users
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'placeholder-key'); // Fallback to placeholder that will be replaced by user's key

// Rate limiting for API calls
const apiCallTimestamps = new Map();
const RATE_LIMIT_WINDOW = 5000; // Increased from 3000 ms to 5000 ms for fewer rate limit errors
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // Increased from 500ms to 1000ms for more gradual retry

function isRateLimited(clientId) {
  const now = Date.now();
  const lastCallTime = apiCallTimestamps.get(clientId) || 0;
  
  if (now - lastCallTime < RATE_LIMIT_WINDOW) {
    return true; // Rate limited
  }
  
  // Update the timestamp for this client
  apiCallTimestamps.set(clientId, now);
  return false; // Not rate limited
}

// Global counter for API calls to prevent quota exhaustion
let apiCallCounter = 0;
const API_CALL_QUOTA_LIMIT = 50; // Adjust based on your actual quota
const API_CALL_RESET_INTERVAL = 60 * 1000; // Reset counter every minute

// Reset the API call counter periodically
setInterval(() => {
  apiCallCounter = 0;
}, API_CALL_RESET_INTERVAL);

// Helper function to check if we're approaching API quota limits
function isApproachingQuotaLimit() {
  return apiCallCounter >= API_CALL_QUOTA_LIMIT;
}

// Helper function to increment the API call counter
function incrementApiCallCounter() {
  apiCallCounter++;
}

// Helper function to convert image file to base64 for Gemini API
function fileToGenerativePart(filePath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString('base64'),
      mimeType
    },
  };
}

// Async function to handle API calls with retry logic
async function callGeminiAPI(apiCallFn, maxRetries = MAX_RETRIES) {
  let retries = 0;
  let delay = INITIAL_RETRY_DELAY;
  
  while (true) {
    try {
      // Check if we're approaching quota limits
      if (isApproachingQuotaLimit()) {
        throw new Error('API quota limit approaching, please try again later');
      }
      
      // Increment the counter before making the call
      incrementApiCallCounter();
      
      // Make the API call
      return await apiCallFn();
    } catch (error) {
      // If we've used all retries or it's not a retryable error, throw
      if (retries >= maxRetries || 
          (!error.message.includes('429') && !error.message.includes('quota') && 
           !error.message.includes('Resource has been exhausted'))) {
        throw error;
      }
      
      // Log the retry attempt
      console.log(`API call failed (attempt ${retries + 1}/${maxRetries}): ${error.message}. Retrying in ${delay}ms...`);
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Exponential backoff with jitter
      delay = Math.min(delay * 2, 10000) * (0.8 + Math.random() * 0.4);
      retries++;
    }
  }
}

// Process text-based questions
async function processTextQuestion(question, apiKey, modelName = 'gemini-2.0-flash-lite') {
  try {
    if (!apiKey) {
      throw new Error('API key is required');
    }
    // Initialize Gemini AI with the provided API key
    const userGenAI = new GoogleGenerativeAI(apiKey);
    // Use the specified model or fallback to flash-lite
    const model = userGenAI.getGenerativeModel({ model: modelName });
    
    // Optimized prompt for faster response - more direct and concise
    const prompt = `Quiz question: "${question}"
Provide ONLY the correct answer(s). If there are choices, only pick from them. Be extremely concise.`;
    
    // Use the retry wrapper
    const result = await callGeminiAPI(() => model.generateContent(prompt));
    return result.response.text();
  } catch (error) {
    console.error('Error processing text question:', error);
    throw error;
  }
}

// Process image-based questions
async function processImageQuestion(imagePath, apiKey, modelName = 'gemini-2.0-flash-lite') {
  try {
    if (!apiKey) {
      throw new Error('API key is required');
    }
    // Mark the file as being processed
    history.markFileProcessing(imagePath);
    
    // Initialize Gemini AI with the provided API key
    const userGenAI = new GoogleGenerativeAI(apiKey);
    // Use the specified model or fallback to flash-lite
    const model = userGenAI.getGenerativeModel({ model: modelName });
    
    // Determine the MIME type based on file extension
    const mimeType = path.extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    
    // Convert image to format required by Gemini API
    const imagePart = fileToGenerativePart(imagePath, mimeType);
    
    // Optimized prompt - shorter and more direct for faster processing
    const prompt = 'Quiz question image. Identify and provide ONLY the correct answer(s). If there are choices, only pick from them. Be extremely concise.';
    
    // Use the retry wrapper
    const result = await callGeminiAPI(() => model.generateContent([prompt, imagePart]));
    return result.response.text();
  } catch (error) {
    console.error('Error processing image question:', error);
    throw error;
  } finally {
    // Mark the file as processed before attempting to delete
    history.markFileProcessed(imagePath);
    // Clean up: safely delete the temporary image file
    history.safelyDeleteFile(imagePath);
  }
}

// Detect if an image contains a quiz question
async function detectQuizQuestion(imagePath, apiKey, modelName = 'gemini-2.0-flash-lite') {
  try {
    if (!apiKey) {
      throw new Error('API key is required');
    }
    // Mark the file as being processed
    history.markFileProcessing(imagePath);
    
    // Initialize Gemini AI with the provided API key
    const userGenAI = new GoogleGenerativeAI(apiKey);
    // Use the specified model or fallback to flash-lite
    const model = userGenAI.getGenerativeModel({ model: modelName });
    
    // Determine the MIME type based on file extension
    const mimeType = path.extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    
    // Convert image to format required by Gemini API
    const imagePart = fileToGenerativePart(imagePath, mimeType);
    
    // Simplified prompt for faster detection
    const prompt = 'Is this a quiz question image? Answer only yes/no.';
    
    // Use the retry wrapper
    const result = await callGeminiAPI(() => model.generateContent([prompt, imagePart]));
    const response = result.response.text().toLowerCase().trim();
    
    // Return true if the response contains 'yes'
    return response.includes('yes');
  } catch (error) {
    console.error('Error detecting quiz question:', error);
    return false;
  } finally {
    // Mark the file as processed before attempting to delete
    history.markFileProcessed(imagePath);
    // Clean up: safely delete the temporary image file
    history.safelyDeleteFile(imagePath);
  }
}

// Process question endpoint
app.post('/process_question', upload.single('image'), async (req, res) => {
  try {
    let answer;
    
    // Check if API key was provided in headers or body
    const apiKey = req.headers['x-api-key'] || req.body.apiKey;
    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' });
    }
    
    // Determine if the request contains text or an image
    if (req.file) {
      // Process image-based question
      answer = await processImageQuestion(req.file.path, apiKey);
      // Note: processImageQuestion already handles image deletion
    } else if (req.body.question) {
      // Process text-based question
      answer = await processTextQuestion(req.body.question, apiKey);
    } else {
      return res.status(400).json({ error: 'No question or image provided' });
    }
    
    // Optimized answer processing - more efficient extraction
    const answers = answer.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('*') && !line.startsWith('#'));
    
    return res.json({ answers });
  } catch (error) {
    console.error('Error processing question:', error);
    // Clean up the image in case of error
    if (req.file && req.file.path) {
      // Mark the file as processed before attempting to delete
      history.markFileProcessed(req.file.path);
      // Safely delete the file
      history.safelyDeleteFile(req.file.path);
    }
    return res.status(500).json({ 
      error: 'Failed to process question', 
      message: error.message 
    });
  }
});

// Screen monitoring endpoint for detecting and processing quiz questions
app.post('/monitor_screen', upload.single('image'), async (req, res) => {
  try {
    // Check if an image was provided
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }
    
    // Check if API key was provided in headers or body
    const apiKey = req.headers['x-api-key'] || req.body.apiKey;
    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' });
    }
    
    // Apply rate limiting based on client IP
    const clientId = req.ip;
    if (isRateLimited(clientId)) {
      // Clean up the image if rate limited
      if (req.file && req.file.path) {
        // Mark the file as processed before attempting to delete
        history.markFileProcessed(req.file.path);
        // Safely delete the file
        history.safelyDeleteFile(req.file.path);
      }
      return res.status(429).json({ 
        error: 'Rate limit exceeded', 
        message: 'Please wait before sending another request' 
      });
    }
    
    // First, detect if the image contains a quiz question
    const containsQuestion = await detectQuizQuestion(req.file.path, apiKey);
    
    if (!containsQuestion) {
      // Note: Image is already deleted in detectQuizQuestion's finally block
      return res.json({ 
        detected: false,
        message: 'No quiz question detected in the image'
      });
    }
    
    // If a question is detected, process it to get the answer
    // Note: processImageQuestion already handles image deletion
    const answer = await processImageQuestion(req.file.path, apiKey);
    
    // Process the answer to extract the most likely correct answer(s)
    const answers = answer.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    return res.json({ 
      detected: true,
      answers: answers
    });
  } catch (error) {
    console.error('Error monitoring screen:', error);
    // Clean up the image in case of error
    if (req.file && req.file.path) {
      // Mark the file as processed before attempting to delete
      history.markFileProcessed(req.file.path);
      // Safely delete the file
      history.safelyDeleteFile(req.file.path);
    }
    return res.status(500).json({ 
      error: 'Failed to process screen capture', 
      message: error.message 
    });
  }
});

// Endpoint to process questions with custom API key
app.post('/process_question_with_key', upload.single('image'), async (req, res) => {
  try {
    // Check if an image or text was provided
    if (!req.file && !req.body.question) {
      return res.status(400).json({ error: 'No image or text question provided' });
    }
    
    // Check if API key was provided
    if (!req.body.apiKey) {
      return res.status(400).json({ error: 'No API key provided' });
    }
    
    // Validate API key format (basic check)
    if (!/^AIza[0-9A-Za-z_-]{35}$/.test(req.body.apiKey)) {
      return res.status(400).json({ 
        error: 'Invalid API key format', 
        message: 'Please provide a valid Gemini API key' 
      });
    }
    
    // Apply rate limiting based on client IP
    const clientId = req.ip;
    if (isRateLimited(clientId)) {
      // Clean up the image if rate limited
      if (req.file && req.file.path) {
        // Mark the file as processed before attempting to delete
        history.markFileProcessed(req.file.path);
        // Safely delete the file
        history.safelyDeleteFile(req.file.path);
      }
      return res.status(429).json({ 
        error: 'Rate limit exceeded', 
        message: 'Please wait before sending another request' 
      });
    }
    
    // Initialize Google Generative AI with the provided API key
    const customGenAI = new GoogleGenerativeAI(req.body.apiKey);
    
    // Get the model name from the request or use default
    const modelName = req.body.model || 'gemini-2.0-flash-lite';
    
    let answer;
    if (req.file) {
      // Process image-based question with custom API key and model
      answer = await processImageQuestionWithKey(req.file.path, customGenAI, modelName);
    } else {
      // Process text-based question with custom API key and model
      answer = await processTextQuestionWithKey(req.body.question, customGenAI, modelName);
    }
    
    // Process the answer to extract the most likely correct answer(s)
    const answers = answer.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    return res.json({ answers: answers });
  } catch (error) {
    console.error('Error processing question with custom key:', error);
    // Clean up the image in case of error
    if (req.file && req.file.path) {
      // Mark the file as processed before attempting to delete
      history.markFileProcessed(req.file.path);
      // Safely delete the file
      history.safelyDeleteFile(req.file.path);
    }
    
    // Provide more specific error messages for common issues
    if (error.message && (error.message.includes('API key') || error.message.includes('authentication') || error.message.includes('invalid key'))) {
      return res.status(401).json({ 
        error: 'API key error', 
        message: 'Invalid API key provided. Please check your API key and try again.' 
      });
    } else if (error.message && error.message.includes('quota')) {
      return res.status(429).json({ 
        error: 'API quota exceeded', 
        message: 'API quota limit reached. Please try again later.' 
      });
    }
    
    return res.status(500).json({ 
      error: 'Failed to process question', 
      message: error.message 
    });
  }
});

// Process text-based questions with custom API key
async function processTextQuestionWithKey(question, customGenAI, modelName = 'gemini-2.0-flash-lite') {
  try {
    // Use the specified model or fallback to flash-lite
    const model = customGenAI.getGenerativeModel({ model: modelName });
    
    // Optimized prompt for faster response - more direct and concise
    const prompt = `Quiz question: "${question}"
Provide ONLY the correct answer(s). Be extremely concise.`;
    
    // Use the retry wrapper
    const result = await callGeminiAPI(() => model.generateContent(prompt));
    return result.response.text();
  } catch (error) {
    console.error('Error processing text question with custom key:', error);
    // Check for API key related errors
    if (error.message && (error.message.includes('API key') || error.message.includes('authentication') || error.message.includes('invalid key'))) {
      throw new Error('Invalid API key provided. Please check your API key and try again.');
    }
    throw error;
  }
}

// Process image-based questions with custom API key
async function processImageQuestionWithKey(imagePath, customGenAI, modelName = 'gemini-2.0-flash-lite') {
  try {
    // Mark the file as being processed
    history.markFileProcessing(imagePath);
    
    // Use the specified model or fallback to flash-lite
    const model = customGenAI.getGenerativeModel({ model: modelName });
    
    // Determine the MIME type based on file extension
    const mimeType = path.extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    
    // Convert image to format required by Gemini API
    const imagePart = fileToGenerativePart(imagePath, mimeType);
    
    // Optimized prompt - shorter and more direct for faster processing
    const prompt = 'Quiz question image. Identify and provide ONLY the correct answer(s). If there are choices, only pick from them. Be extremely concise.';
    
    // Use the retry wrapper
    const result = await callGeminiAPI(() => model.generateContent([prompt, imagePart]));
    return result.response.text();
  } catch (error) {
    console.error('Error processing image question with custom key:', error);
    // Check for API key related errors
    if (error.message && (error.message.includes('API key') || error.message.includes('authentication') || error.message.includes('invalid key'))) {
      throw new Error('Invalid API key provided. Please check your API key and try again.');
    }
    throw error;
  } finally {
    // Mark the file as processed before attempting to delete
    history.markFileProcessed(imagePath);
    // Clean up: safely delete the temporary image file
    history.safelyDeleteFile(imagePath);
  }
}

// Start the server
function startServer(port) {
  // Ensure port is a number
  port = parseInt(port, 10);
  
  const server = app.listen(port)
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // If port 3000 is in use, specifically try port 3001
        if (port === 3000) {
          console.log(`Port ${port} is already in use, trying port 3001`);
          startServer(3001);
        } else {
          console.log(`Port ${port} is already in use, trying port ${port + 1}`);
          startServer(port + 1);
        }
      } else {
        console.error('Server error:', err);
      }
    })
    .on('listening', () => {
      const actualPort = server.address().port;
      console.log(`Screen Answerer server running on port ${actualPort}`);
    });
}

startServer(PORT);