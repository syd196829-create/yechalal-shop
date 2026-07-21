const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

module.exports = async (req, res) => {
  try {
    const channel = req.query.channel;
    const uid = req.query.uid || 0;

    if (!channel) {
      res.status(400).json({ error: 'channel parameter is required' });
      return;
    }

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      res.status(500).json({ error: 'Agora credentials not configured on server' });
      return;
    }

    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
    const role = RtcRole.PUBLISHER;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channel,
      Number(uid),
      role,
      privilegeExpiredTs
    );

    res.status(200).json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
};
