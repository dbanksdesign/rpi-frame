import express from 'express';
import cors from 'cors';
import path from 'path';
import { router as apiRouter } from './routes/api';
import { ensureDirectories, getProjectRoot } from './utils/filesystem';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Ensure required directories exist
ensureDirectories();

// Serve uploaded images statically
const uploadsPath = path.join(getProjectRoot(), 'uploads');
console.log('Serving uploads from:', uploadsPath);
app.use('/uploads', express.static(uploadsPath));

// API routes
app.use('/api', apiRouter);

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client')));
  app.get('*', (_, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
  });
}

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Access from other devices on your network using your Pi's IP address`);
});

