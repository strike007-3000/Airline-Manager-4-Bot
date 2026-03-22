export class ConfigUtils {
    public static requireString(name: string): string {
        const value = process.env[name]?.trim();

        if (!value) {
            throw new Error(`Missing required environment variable: ${name}`);
        }

        return value;
    }

    public static requireNumber(name: string): number {
        const value = this.requireString(name);
        const parsedValue = Number.parseInt(value, 10);

        if (Number.isNaN(parsedValue)) {
            throw new Error(`Environment variable ${name} must be a valid integer.`);
        }

        return parsedValue;
    }
}
