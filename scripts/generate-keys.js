// Run once: `npm run keys:generate`
//
// Gives every service its own identity: an RSA key pair.
//   keys/<service>.private.pem  -> SECRET. Only that service should have it. Used to SIGN tokens.
//   keys/<service>.public.pem   -> shareable. Other services use it to VERIFY that service's tokens.
//
// In production the private key would come from a secret manager (Vault,
// AWS Secrets Manager, k8s Secret...) and each service would only see its own.
// Here they all sit in one folder to keep the demo easy to run.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SERVICES = ['gateway', 'user-service', 'order-service'];
const KEYS_DIR = path.join(__dirname, '..', 'keys');
const force = process.argv.includes('--force');

fs.mkdirSync(KEYS_DIR, { recursive: true });

for (const name of SERVICES) {
  const privPath = path.join(KEYS_DIR, `${name}.private.pem`);
  const pubPath = path.join(KEYS_DIR, `${name}.public.pem`);

  if (fs.existsSync(privPath) && !force) {
    console.log(`skip    ${name} (keys exist, use --force to regenerate)`);
    continue;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.writeFileSync(privPath, privateKey, { mode: 0o600 }); // owner-only
  fs.writeFileSync(pubPath, publicKey);
  console.log(`created ${name}`);
}
