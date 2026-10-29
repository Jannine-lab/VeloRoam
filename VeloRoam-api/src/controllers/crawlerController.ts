import { Request, Response } from 'express';
import {
  getStravaCrawlerStatus,
  startStravaCrawler,
  stopStravaCrawler,
  triggerStravaCrawlerRunOnce
} from '../scripts/stravaCrawler';
import {
  getAmapHotPointCrawlerStatus,
  startAmapHotPointCrawler,
  stopAmapHotPointCrawler,
  triggerAmapHotPointCrawlerRunOnce
} from '../scripts/amapHotPointCrawler';

function crawlerMutationAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.ENABLE_CRAWLER_API === 'true';
}

function crawlerStatusPayload() {
  return {
    crawlerApi: {
      mutationAllowed: crawlerMutationAllowed(),
      environment: process.env.NODE_ENV || 'development'
    },
    strava: getStravaCrawlerStatus(),
    hotPoints: getAmapHotPointCrawlerStatus()
  };
}

function rejectDisabledMutation(res: Response): Response | null {
  if (crawlerMutationAllowed()) return null;

  return res.status(403).json({
    error: 'Crawler mutations are disabled in production.',
    details: 'Set ENABLE_CRAWLER_API=true on the server to allow crawler run/start/stop requests.'
  });
}

export const getCrawlerStatus = (_req: Request, res: Response) => {
  return res.status(200).json(crawlerStatusPayload());
};

export const runStravaCrawlerOnce = (_req: Request, res: Response) => {
  const rejected = rejectDisabledMutation(res);
  if (rejected) return rejected;

  const accepted = triggerStravaCrawlerRunOnce();
  if (!accepted) {
    return res.status(409).json({
      error: 'Strava crawler is already running or its scheduler is enabled.',
      status: getStravaCrawlerStatus()
    });
  }

  return res.status(202).json({
    accepted: true,
    crawler: 'strava',
    action: 'run_once',
    message: 'The next Strava grid crawl started in the background.',
    status: getStravaCrawlerStatus()
  });
};

export const startStravaCrawlerScheduler = (_req: Request, res: Response) => {
  const rejected = rejectDisabledMutation(res);
  if (rejected) return rejected;

  const accepted = startStravaCrawler();
  if (!accepted) {
    return res.status(409).json({
      error: 'Strava crawler is already running.',
      status: getStravaCrawlerStatus()
    });
  }

  return res.status(202).json({
    accepted: true,
    crawler: 'strava',
    action: 'start_scheduler',
    message: 'The Strava crawler scheduler started with a 10 second interval.',
    status: getStravaCrawlerStatus()
  });
};

export const stopStravaCrawlerScheduler = (_req: Request, res: Response) => {
  const rejected = rejectDisabledMutation(res);
  if (rejected) return rejected;

  const accepted = stopStravaCrawler();
  return res.status(200).json({
    accepted,
    crawler: 'strava',
    action: 'stop_scheduler',
    message: accepted
      ? 'The Strava crawler scheduler was stopped. An in-flight request may still finish.'
      : 'The Strava crawler scheduler was already stopped.',
    status: getStravaCrawlerStatus()
  });
};

export const runHotPointCrawlerOnce = (_req: Request, res: Response) => {
  const rejected = rejectDisabledMutation(res);
  if (rejected) return rejected;

  const accepted = triggerAmapHotPointCrawlerRunOnce();
  if (!accepted) {
    return res.status(409).json({
      error: 'Hot-point crawler is already running.',
      status: getAmapHotPointCrawlerStatus()
    });
  }

  return res.status(202).json({
    accepted: true,
    crawler: 'hot_points',
    action: 'run_once',
    message: 'The Shanghai hot-point crawl started in the background.',
    status: getAmapHotPointCrawlerStatus()
  });
};

export const startHotPointCrawlerScheduler = (_req: Request, res: Response) => {
  const rejected = rejectDisabledMutation(res);
  if (rejected) return rejected;

  const accepted = startAmapHotPointCrawler();
  if (!accepted) {
    return res.status(409).json({
      error: 'Hot-point crawler scheduler is already enabled.',
      status: getAmapHotPointCrawlerStatus()
    });
  }

  return res.status(202).json({
    accepted: true,
    crawler: 'hot_points',
    action: 'start_scheduler',
    message: 'The hot-point crawler scheduler started and queued its first cycle.',
    status: getAmapHotPointCrawlerStatus()
  });
};

export const stopHotPointCrawlerScheduler = (_req: Request, res: Response) => {
  const rejected = rejectDisabledMutation(res);
  if (rejected) return rejected;

  const accepted = stopAmapHotPointCrawler();
  return res.status(200).json({
    accepted,
    crawler: 'hot_points',
    action: 'stop_scheduler',
    message: accepted
      ? 'The hot-point crawler scheduler was stopped. An in-flight crawl may still finish.'
      : 'The hot-point crawler scheduler was already stopped.',
    status: getAmapHotPointCrawlerStatus()
  });
};
