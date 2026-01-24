import { consts } from '../consts';

export class Logger {
    private static get prefix(): string {
        return `[${consts.EXTENSION_ID}]`;
    }

    public static info(message: string, ...args: any[]) {
        console.log(`${this.prefix} ${message}`, ...args);
    }

    public static warn(message: string, ...args: any[]) {
        console.warn(`${this.prefix} ${message}`, ...args);
    }

    public static error(message: string, ...args: any[]) {
        console.error(`${this.prefix} ${message}`, ...args);
    }
}
