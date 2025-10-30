const crypto = require('crypto');

const ENCRYPTION_KEY_ENV = 'ENCRYPTION_KEY';
const VERSION = 'v1';
const PREFIX = `enc:${VERSION}:`;
const IV_LENGTH = 12; // AES-GCM recommended IV length

let cachedKeyBuffer = null;
let cachedKeySource = null;

function isHexKey(value) {
  return /^[0-9a-f]{64}$/i.test(value);
}

function isProbablyBase64(value) {
  return /^[A-Za-z0-9+/=]{43,}$/.test(value);
}

function deriveKeyBuffer(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') {
    throw new Error('ENCRYPTION_KEY must be provided to use sensitive data encryption');
  }

  if (isHexKey(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  if (isProbablyBase64(rawKey)) {
    const asBase64 = Buffer.from(rawKey, 'base64');
    if (asBase64.length === 32) {
      return asBase64;
    }
  }

  // Fallback to SHA-256 digest of provided string
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
}

function getEncryptionKey() {
  const rawKey = process.env[ENCRYPTION_KEY_ENV];
  if (!rawKey) {
    throw new Error('ENCRYPTION_KEY environment variable is required for password encryption');
  }

  if (cachedKeyBuffer && cachedKeySource === rawKey) {
    return cachedKeyBuffer;
  }

  const keyBuffer = deriveKeyBuffer(rawKey);
  if (keyBuffer.length !== 32) {
    throw new Error(
      'Derived encryption key must be 32 bytes. Provide 32-byte hex/base64 or a longer passphrase.'
    );
  }

  cachedKeyBuffer = keyBuffer;
  cachedKeySource = rawKey;
  return cachedKeyBuffer;
}

function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptSecret(value) {
  if (value === null || value === undefined || value === '') {
    return value;
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintextBuffer = Buffer.from(String(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}:${encrypted.toString('base64')}:${authTag.toString('base64')}`;
}

function decryptSecret(value) {
  if (value === null || value === undefined || value === '') {
    return value;
  }

  if (!isEncryptedSecret(value)) {
    return value;
  }

  const key = getEncryptionKey();
  const payload = value.slice(PREFIX.length);
  const [ivB64, dataB64, tagB64] = payload.split(':');

  if (!ivB64 || !dataB64 || !tagB64) {
    throw new Error('Encrypted secret has invalid format');
  }

  const iv = Buffer.from(ivB64, 'base64');
  const encrypted = Buffer.from(dataB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret
};
