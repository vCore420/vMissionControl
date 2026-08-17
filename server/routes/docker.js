import { Router } from 'express';
import { listDockerContainers } from '../docker.js';

export const dockerRouter = Router();

// Backs the "Browse…" container picker in the Add/Edit Service modal —
// read-only, so it only needs the app's normal session auth, same as the
// logs endpoint in routes/services.js.
dockerRouter.get('/containers', async (req, res) => {
  try {
    const containers = await listDockerContainers();
    res.json({ containers });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
