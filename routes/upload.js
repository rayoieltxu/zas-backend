/**
 * routes/upload.js
 * POST /upload/image — sube una imagen base64 a Cloudinary
 * Usado por posts, stories y avatares.
 */
const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');

// POST /upload/image
// Body: { image_base64: "data:image/jpeg;base64,..." , folder?: "posts"|"stories" }
router.post('/image', auth, async (req, res) => {
  const { image_base64, folder = 'posts' } = req.body;
  if (!image_base64) return res.status(400).json({ error: 'image_base64 required' });

  // Tamaño máximo ~4 MB base64
  if (image_base64.length > 5_500_000)
    return res.status(413).json({ error: 'Imagen demasiado grande (máx 4 MB)' });

  const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
  const API_KEY    = process.env.CLOUDINARY_API_KEY;
  const API_SECRET = process.env.CLOUDINARY_API_SECRET;

  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    return res.status(500).json({ error: 'Cloudinary no configurado en el servidor' });
  }

  try {
    // Upload directo a la API de Cloudinary sin SDK (menor dependencia)
    const timestamp = Math.floor(Date.now() / 1000);
    const publicId  = `zas/${folder}/${req.user.id}_${timestamp}`;

    // Firma
    const crypto = require('crypto');
    const strToSign = `folder=zas%2F${folder}&public_id=${publicId}&timestamp=${timestamp}${API_SECRET}`;
    // Cloudinary usa SHA1 sobre la cadena de parámetros ordenados + secret
    const paramsToSign = `folder=zas/${folder}&public_id=${publicId}&timestamp=${timestamp}`;
    const signature = crypto
      .createHash('sha256')
      .update(paramsToSign + API_SECRET)
      .digest('hex');

    const formData = new URLSearchParams();
    formData.append('file',       image_base64);
    formData.append('api_key',    API_KEY);
    formData.append('timestamp',  String(timestamp));
    formData.append('public_id',  publicId);
    formData.append('folder',     `zas/${folder}`);
    formData.append('signature',  signature);

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
      { method: 'POST', body: formData }
    );

    const data = await response.json();
    if (!response.ok || data.error) {
      console.error('Cloudinary error:', data.error);
      return res.status(500).json({ error: data.error?.message || 'Error subiendo imagen' });
    }

    res.json({ url: data.secure_url });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Error interno al subir imagen' });
  }
});

module.exports = router;
