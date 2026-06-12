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

  if (image_base64.length > 5_500_000)
    return res.status(413).json({ error: 'Imagen demasiado grande (máx 4 MB)' });

  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)
    return res.status(500).json({ error: 'Cloudinary no configurado en el servidor' });

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const publicId  = `zas/${folder}/${req.user.id}_${timestamp}`;

    const result = await cloudinary.uploader.upload(image_base64, {
      public_id: publicId,
      folder:    `zas/${folder}`,
      format:    'jpg',
      overwrite: true,
    });

    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('Upload image error:', err);
    res.status(500).json({ error: err.message || 'Error interno al subir imagen' });
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
        {
          resource_type: 'video',
          public_id:     publicId,
          folder:        `zas/${folder}`,
          transformation: [
            { video_codec: 'h264', audio_codec: 'aac', quality: 'auto' },
          ],
          eager: [
            { video_codec: 'h264', audio_codec: 'aac', format: 'mp4' },
          ],
          eager_async: false,
        },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      Readable.from(req.file.buffer).pipe(stream);
    });

    // Preferir la versión eager (H.264/AAC garantizado para iOS)
    const videoUrl  = result.eager?.[0]?.secure_url || result.secure_url;
    const thumbnail = videoUrl
      .replace('/upload/', '/upload/so_0/')
      .replace(/\.\w+$/, '.jpg');

    res.json({ url: videoUrl, thumbnail });
  } catch (err) {
    console.error('Video upload error:', err);
    res.status(500).json({ error: err.message || 'Error interno al subir vídeo' });
  }
});

module.exports = router;
