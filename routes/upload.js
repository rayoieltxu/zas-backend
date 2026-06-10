/**
 * routes/upload.js
 * POST /upload/image — sube una imagen base64 a Cloudinary
 * POST /upload/video — sube un vídeo multipart a Cloudinary
 * Usado por posts, stories y avatares.
 */
const express    = require('express');
const router     = express.Router();
const auth       = require('../middleware/auth');
const crypto     = require('crypto');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

// Multer en memoria para vídeos (máx 200 MB)
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

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
    const timestamp = Math.floor(Date.now() / 1000);
    const publicId  = `zas/${folder}/${req.user.id}_${timestamp}`;
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

// POST /upload/video
// Multipart form-data: campo "video" (archivo) + campo "folder" (opcional)
router.post('/video', auth, videoUpload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió el archivo de vídeo' });

  const folder = req.body?.folder || 'videos';

  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)
    return res.status(500).json({ error: 'Cloudinary no configurado' });

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  try {
    const publicId = `zas/${folder}/${req.user.id}_${Date.now()}`;

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'video', public_id: publicId, folder: `zas/${folder}` },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      Readable.from(req.file.buffer).pipe(stream);
    });

    const thumbnail = result.secure_url
      .replace('/upload/', '/upload/so_0/')
      .replace(/\.\w+$/, '.jpg');

    res.json({ url: result.secure_url, thumbnail });
  } catch (err) {
    console.error('Video upload error:', err);
    res.status(500).json({ error: err.message || 'Error interno al subir vídeo' });
  }
});

module.exports = router;
