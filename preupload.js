const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

(async () => {
  try {
    const UPLOAD_URL = process.env.UPLOAD_URL;
    const UPLOAD_API_KEY = process.env.UPLOAD_API_KEY;
    const PDF_PATH = process.env.PDF_PATH || './assets/document.pdf';

    if (!UPLOAD_URL || !UPLOAD_API_KEY) {
      console.error('UPLOAD_URL and UPLOAD_API_KEY required');
      process.exit(1);
    }
    if (!fs.existsSync(PDF_PATH)) {
      console.error('PDF not found at', PDF_PATH);
      process.exit(1);
    }

    const formData = new FormData();
    formData.append('file', fs.createReadStream(PDF_PATH));

    const headers = {
      ...formData.getHeaders(),
      'Authorization': `Bearer ${UPLOAD_API_KEY}`
    };

    console.log('Uploading PDF to provider...');
    const resp = await axios.post(UPLOAD_URL, formData, { headers, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 60000 });

    console.log('Upload response status:', resp.status);
    console.log('Upload response data:', JSON.stringify(resp.data, null, 2));

    const mediaId = resp.data?.media_id || resp.data?.id || resp.data?.data?.id || resp.data?.media?.[0]?.id;
    if (!mediaId) {
      console.log('\nCould not auto-detect media_id in the response. Copy it manually to MEDIA_ID env var.');
    } else {
      console.log('\nSUCCESS. MEDIA_ID (set this in Railway env vars):', mediaId);
    }
  } catch (err) {
    console.error('Upload failed', err?.response?.data || err.message);
    process.exit(1);
  }
})();