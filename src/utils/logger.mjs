import winston from "winston";
import fs from "node:fs/promises";
import path from "node:path";

const logsDir = path.join(process.cwd(), "logs");

// Create logs directory
try {
    await fs.mkdir(logsDir, { recursive: true });
} catch (error) {
    console.error("Error creating logs directory:", error);
}

// Custom format for console output
const consoleFormat = winston.format.printf(({ level, message, timestamp }) => {
    return `${timestamp} ${level}: ${message}`;
});

export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error'
        }),
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log')
        }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp(),
                consoleFormat
            )
        })
    ]
});
