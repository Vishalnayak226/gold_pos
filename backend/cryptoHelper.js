import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError, DATA_DIR } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(__dirname, 'keys');
const PUBLIC_KEY_FILE = path.join(KEYS_DIR, 'developer_public.pem');

// Ensure keys directory exists
if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

/**
 * Ensures a developer public key is present.
 * If missing, generates a mock developer RSA-4096 keypair for out-of-the-box testing.
 * The Private Key is saved in a secure scratch folder for developer-only testing.
 */
function ensureKeysExist() {
    try {
        if (!fs.existsSync(PUBLIC_KEY_FILE)) {
            // Security audit L1: never mint a fresh throwaway keypair on a live
            // tenant machine — the private half would land in
            // developer_doomsday_keys/ right beside the data it decrypts. A
            // production install ships developer_public.pem already (see
            // release_pipeline.js); a missing key there means an incomplete
            // deploy, and Level-2 export is the only thing that degrades.
            if (process.env.NODE_ENV === 'production') {
                logError('Developer public key (backend/keys/developer_public.pem) is missing in production. Refusing to auto-generate a new keypair on this machine — Level-2 diagnostic exports will fail until the shipped key is restored. See docs/SECURITY_AUDIT.md L1.');
                return;
            }

            console.log('[Crypto] Developer public key missing. Generating mock developer RSA-4096 keypair for local verification...');

            const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 4096,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
            });

            fs.writeFileSync(PUBLIC_KEY_FILE, publicKey, 'utf8');

            // Save the Private Key to a secure location in the workspace (scratch) for developer decrypt testing
            const devScratchDir = path.join(__dirname, '../developer_doomsday_keys');
            if (!fs.existsSync(devScratchDir)) fs.mkdirSync(devScratchDir, { recursive: true });
            
            const privateKeyPath = path.join(devScratchDir, 'developer_private.pem');
            fs.writeFileSync(privateKeyPath, privateKey, 'utf8');
            
            console.log(`[Crypto] Mock RSA keys generated successfully!`);
            console.log(`[Crypto] Public Key embedded at: ${PUBLIC_KEY_FILE}`);
            console.log(`[Crypto] PRIVATE KEY (KEEP SECURE) saved to developer scratch folder: ${privateKeyPath}`);
        }
    } catch (err) {
        logError('Failed to initialize cryptographic RSA keypair: ' + err.message, err.stack);
    }
}

// Auto-run key bootstrap on import
ensureKeysExist();

/**
 * Encrypts a JSON payload (Level 2 Customer Data) using an asymmetric envelope.
 * 1. Generates ephemeral AES-256 key and IV.
 * 2. Encrypts payload with AES-256-GCM.
 * 3. Encrypts the AES key with the Developer's RSA-4096 Public Key.
 * 
 * @param {string} payloadJsonString - The raw sensitive JSON string
 * @returns {object} Encrypted envelope containing encrypted key, iv, authTag, and ciphertext
 */
export function encryptLevel2Payload(payloadJsonString) {
    try {
        const publicKeyPem = fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');

        // 1. Generate Ephemeral AES Key and Initialization Vector (IV)
        const aesKey = crypto.randomBytes(32); // 256-bit key
        const iv = crypto.randomBytes(12);     // 96-bit IV suitable for GCM

        // 2. Encrypt the data using AES-GCM
        const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
        let ciphertext = cipher.update(payloadJsonString, 'utf8', 'hex');
        ciphertext += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');

        // 3. Encrypt the AES key with the Developer's RSA Public Key
        const encryptedAesKey = crypto.publicEncrypt({
            key: publicKeyPem,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, aesKey).toString('base64');

        return {
            encryptedAesKey,
            iv: iv.toString('hex'),
            authTag,
            ciphertext
        };
    } catch (err) {
        logError('Level-2 encryption failed: ' + err.message, err.stack);
        throw new Error('Encryption engine failure');
    }
}

/**
 * Decrypts a Level 2 encrypted envelope using the offline Developer Private Key.
 * (This is run locally by the developer in the SaaS Analyzer module).
 * 
 * @param {object} envelope - The encrypted envelope object
 * @param {string} privateKeyPem - The offline developer RSA Private Key
 * @returns {string} The original decrypted JSON string
 */
export function decryptLevel2Payload(envelope, privateKeyPem) {
    try {
        const { encryptedAesKey, iv, authTag, ciphertext } = envelope;

        // 1. Decrypt the AES key using the RSA Private Key
        const aesKey = crypto.privateDecrypt({
            key: privateKeyPem,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, Buffer.from(encryptedAesKey, 'base64'));

        // 2. Decrypt the ciphertext using AES-GCM
        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(iv, 'hex'));
        decipher.setAuthTag(Buffer.from(authTag, 'hex'));
        
        let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (err) {
        logError('Level-2 decryption failed: ' + err.message, err.stack);
        throw new Error('Decryption failed: ' + err.message);
    }
}
