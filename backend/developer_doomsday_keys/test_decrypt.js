import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE_KEY_FILE = path.join(__dirname, 'developer_private.pem');

/**
 * Decrypts a Level 2 database envelope using the developer private key
 * Usage: node test_decrypt.js <path_to_envelope_json> [output_path_json]
 */
function decryptEnvelope() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.log('Error: Missing envelope file path.');
        console.log('Usage: node test_decrypt.js <path_to_envelope_json> [output_path_json]');
        return;
    }

    const envelopePath = path.resolve(args[0]);
    const outputPath = args[1] ? path.resolve(args[1]) : path.join(__dirname, 'decrypted_databases.json');

    if (!fs.existsSync(envelopePath)) {
        console.error(`Error: Envelope file not found at ${envelopePath}`);
        return;
    }

    if (!fs.existsSync(PRIVATE_KEY_FILE)) {
        console.error(`Error: Developer Private Key file not found at ${PRIVATE_KEY_FILE}`);
        console.error('Make sure you have generated the keys or copied them here.');
        return;
    }

    try {
        const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
        const privateKeyPem = fs.readFileSync(PRIVATE_KEY_FILE, 'utf8');

        const { encryptedAesKey, iv, authTag, ciphertext } = envelope.envelope || envelope;

        console.log('[Decryptor] Decrypting AES session key with RSA-4096 Private Key...');
        // 1. Decrypt AES Key using Developer's Private Key
        const aesKey = crypto.privateDecrypt({
            key: privateKeyPem,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, Buffer.from(encryptedAesKey, 'base64'));

        console.log('[Decryptor] Decrypting ciphertext with AES-256-GCM session key...');
        // 2. Decrypt Ciphertext using AES-GCM
        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(iv, 'hex'));
        decipher.setAuthTag(Buffer.from(authTag, 'hex'));

        let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        // Pretty print output
        const prettyJson = JSON.stringify(JSON.parse(decrypted), null, 2);
        fs.writeFileSync(outputPath, prettyJson, 'utf8');

        console.log(`[Decryptor] SUCCESS! Decrypted database output written to: ${outputPath}`);
    } catch (err) {
        console.error('[Decryptor] DECRYPTION FAILED. Invalid key, corrupted IV, or manipulated authTag.');
        console.error(err);
    }
}

decryptEnvelope();
