import { logger } from './logger.mjs';

export class HealthCheck {
    constructor() {
        this.lastCheck = new Date();
        this.status = {
            healthy: true,
            lastError: null,
            apiStatus: 'operational',
            processedInLastMinute: 0,
            failuresInLastMinute: 0
        };

        // Reset counters every minute
        setInterval(() => {
            this.status.processedInLastMinute = 0;
            this.status.failuresInLastMinute = 0;
        }, 60000);
    }

    updateStatus(stats) {
        this.status.processedInLastMinute++;

        if (stats.failed > stats.successful * 0.3) { // Over 30% failure rate
            this.status.healthy = false;
            this.status.lastError = 'High failure rate detected';
            logger.warn('Health check: High failure rate detected');
        }

        if (stats.rateLimited > 5) { // Too many rate limits
            this.status.apiStatus = 'degraded';
            logger.warn('Health check: Too many rate limits');
        }

        return this.status;
    }
} 