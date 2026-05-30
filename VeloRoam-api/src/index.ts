import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import routeRoutes from './routes/routeRoutes';

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/routes', routeRoutes);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development'
  });
});

// Start server
app.listen(Number(port), '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`🚴 VeloRoam API Server is running!`);
  console.log(`🔌 Port: ${port}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`========================================`);
});

export default app;
