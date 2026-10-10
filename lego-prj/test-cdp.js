const http = require('http');

http.get('http://127.0.0.1:9222/json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const tabs = JSON.parse(data);
      console.log('Tabs found:', tabs.length);
      tabs.forEach((t, i) => console.log(`[${i}] ${t.type}: ${t.title} -> ${t.url}`));
    } catch (e) {
      console.error('Parse error:', e.message, data);
    }
  });
}).on('error', err => console.error('HTTP error:', err.message));
