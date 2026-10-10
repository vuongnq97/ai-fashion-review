const axios = require('axios');
const fs = require('fs');
const https = require('https');

async function testNodeDownload() {
  const url = "https://flow-content.google/image/3b85828a-0e26-4476-a55a-993d88a93bb8?Expires=1791494366&KeyName=labs-flow-prod-cdn-key&Signature=tvOFEDCFRykZNALjxFt6BPXEaPE";

  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      }
    });

    const buf = Buffer.from(res.data);
    fs.writeFileSync('./outputs/heihei_panel_hd.png', buf);
    console.log(`✅ DOWNLOADED FULL HD PANEL: ${(buf.length / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.error('Error:', err.message, err.response?.data?.toString());
  }
}

testNodeDownload();
