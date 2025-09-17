# whapi-whatsapp-pdf-bot

Simple webhook service that replies to inbound messages with a pre-uploaded PDF using Whapi.Cloud.

## Steps

1. Upload your PDF to Whapi.Cloud and copy the MEDIA_ID (or run preupload.js).
2. Set Railway env vars: SEND_URL, SEND_API_KEY, MEDIA_ID.
3. Deploy project to Railway.
4. Configure Whapi webhook to point to https://<your-railway-domain>/webhook.
5. Test by sending a WhatsApp message to the connected number.

Env vars:
- SEND_URL (e.g. https://api.whapi.cloud/v1/messages)
- SEND_API_KEY (your Whapi API key)
- MEDIA_ID (the ID of uploaded PDF)
- VERIFY_TOKEN (optional, if Whapi requires verification)
