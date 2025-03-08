// history.js - Tracks image processing history to prevent premature deletion

const fs = require('fs');
const path = require('path');

// Map to track files that are currently being processed
const processingFiles = new Map();

// Map to track files that are being used by multiple processes
const fileReferences = new Map();

/**
 * Mark a file as being processed
 * @param {string} filePath - Path to the file being processed
 * @returns {void}
 */
function markFileProcessing(filePath) {
  processingFiles.set(filePath, Date.now());
  
  // Increment reference count
  const refCount = fileReferences.get(filePath) || 0;
  fileReferences.set(filePath, refCount + 1);
}

/**
 * Check if a file is currently being processed
 * @param {string} filePath - Path to the file to check
 * @returns {boolean} - True if the file is being processed, false otherwise
 */
function isFileProcessing(filePath) {
  return processingFiles.has(filePath);
}

/**
 * Mark a file as done processing
 * @param {string} filePath - Path to the file that's done processing
 * @returns {void}
 */
function markFileProcessed(filePath) {
  processingFiles.delete(filePath);
  
  // Decrement reference count
  const refCount = fileReferences.get(filePath) || 0;
  if (refCount > 1) {
    fileReferences.set(filePath, refCount - 1);
  } else {
    fileReferences.delete(filePath);
  }
}

/**
 * Safely delete a file only if it's not being processed
 * @param {string} filePath - Path to the file to delete
 * @returns {boolean} - True if the file was deleted, false if it's still being processed
 */
function safelyDeleteFile(filePath) {
  // Don't delete if the file is still being processed
  if (isFileProcessing(filePath)) {
    console.log(`File ${filePath} is still being processed, skipping deletion`);
    return false;
  }
  
  // Don't delete if the file still has active references
  const refCount = fileReferences.get(filePath) || 0;
  if (refCount > 0) {
    console.log(`File ${filePath} still has ${refCount} active references, skipping deletion`);
    return false;
  }
  
  try {
    // Check if file exists before attempting to delete
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Successfully deleted file: ${filePath}`);
      return true;
    } else {
      console.log(`File not found for deletion: ${filePath}`);
      return true; // Return true since the file doesn't exist anyway
    }
  } catch (err) {
    console.error(`Error deleting file ${filePath}:`, err);
    return false;
  }
}

/**
 * Clean up old processing entries (files that have been in processing state for too long)
 * @param {number} maxAgeMs - Maximum age in milliseconds before considering a processing entry stale
 * @returns {void}
 */
function cleanupStaleEntries(maxAgeMs = 5 * 60 * 1000) { // Default 5 minutes
  const now = Date.now();
  
  for (const [filePath, timestamp] of processingFiles.entries()) {
    if (now - timestamp > maxAgeMs) {
      console.log(`Removing stale processing entry for ${filePath}`);
      processingFiles.delete(filePath);
    }
  }
}

/**
 * Ensure the uploads directory exists
 * @returns {string} - Path to the uploads directory
 */
function ensureUploadsDirectory() {
  const uploadDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log(`Created uploads directory at ${uploadDir}`);
  }
  return uploadDir;
}

// Run cleanup every minute
setInterval(cleanupStaleEntries, 60 * 1000);

// Ensure uploads directory exists on module load
ensureUploadsDirectory();

module.exports = {
  markFileProcessing,
  isFileProcessing,
  markFileProcessed,
  safelyDeleteFile,
  ensureUploadsDirectory
};