const http = require('http');

const PORT = process.env.PORT || 8080;

const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (res.statusCode === 200 && json.status === 'ok') {
        console.log('Health check passed:', json);
        process.exit(0);
      } else {
        console.error('Health check failed with response:', data);
        process.exit(1);
      }
    } catch (e) {
      console.error('Failed to parse health response:', data);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error('Connection error during test:', err.message);
  process.exit(1);
});
