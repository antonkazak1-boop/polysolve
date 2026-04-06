import { Router, Request, Response } from 'express';
import {
  predictLive,
  buildGoldCurves,
  buildObjectiveStats,
  LiveGameState,
} from '../../services/lol-live-predictor';

export const lolLiveRouter = Router();

lolLiveRouter.post('/lol/live/predict', async (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<LiveGameState>;

    const state: LiveGameState = {
      blueChamps: body.blueChamps ?? [],
      redChamps: body.redChamps ?? [],
      bluePlayers: body.bluePlayers,
      redPlayers: body.redPlayers,
      minute: Math.max(0, Math.min(90, body.minute ?? 0)),
      goldDiffTotal: body.goldDiffTotal ?? 0,
      goldDiffByLane: body.goldDiffByLane,
      blueDragons: body.blueDragons ?? [],
      redDragons: body.redDragons ?? [],
      blueDragonSoul: body.blueDragonSoul ?? false,
      redDragonSoul: body.redDragonSoul ?? false,
      blueElderDragon: body.blueElderDragon ?? 0,
      redElderDragon: body.redElderDragon ?? 0,
      blueVoidgrubs: body.blueVoidgrubs ?? 0,
      redVoidgrubs: body.redVoidgrubs ?? 0,
      blueHerald: body.blueHerald ?? 0,
      redHerald: body.redHerald ?? 0,
      blueBaron: body.blueBaron ?? 0,
      redBaron: body.redBaron ?? 0,
      blueTowersDestroyed: body.blueTowersDestroyed ?? 0,
      redTowersDestroyed: body.redTowersDestroyed ?? 0,
      draftPMap: body.draftPMap,
    };

    const result = await predictLive(state);
    res.json(result);
  } catch (err: any) {
    console.error('Live predict error:', err);
    res.status(500).json({ error: err.message ?? 'Prediction failed' });
  }
});

lolLiveRouter.get('/lol/live/gold-curves', async (_req: Request, res: Response) => {
  try {
    const curves = await buildGoldCurves();
    res.json(curves);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

lolLiveRouter.get('/lol/live/objective-stats', async (_req: Request, res: Response) => {
  try {
    const stats = await buildObjectiveStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
