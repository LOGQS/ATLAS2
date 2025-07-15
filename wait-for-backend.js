const http = require('http');

const BACKEND_URL = 'http://localhost:5000';
const MAX_RETRIES = 30;
const RETRY_INTERVAL = 1000; // 1 second

async function checkBackend() {
  return new Promise((resolve) => {
    const req = http.get(`${BACKEND_URL}/api/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    
    req.on('error', () => {
      resolve(false);
    });
    
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForBackend() {
  console.log('Waiting for backend to be ready...');
  
  for (let i = 0; i < MAX_RETRIES; i++) {
    const isReady = await checkBackend();
    
    if (isReady) {
      console.log('Backend is ready! Starting frontend...');
      return;
    }
    
    process.stdout.write('.');
    await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL));
  }
  
  console.log('\nWarning: Backend may not be fully ready, but starting frontend anyway...');
}

waitForBackend().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Error waiting for backend:', error);
  process.exit(1);
});