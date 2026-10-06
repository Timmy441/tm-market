const crypto = require('crypto');

// Only images hosted in OUR Cloudinary account are accepted.
function isTrustedImageUrl(url) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud || typeof url !== 'string' || url.length > 500) return false;
  return url.startsWith(`https://res.cloudinary.com/${cloud}/`);
}

// Signs an upload for a folder. The API secret never leaves the backend.
function signUploadParams(folder) {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = process.env;
  if (!cloudName || !apiKey || !secret) return null;

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${secret}`).digest('hex');
  return { cloudName, apiKey, timestamp, folder, signature };
}

module.exports = { isTrustedImageUrl, signUploadParams };
