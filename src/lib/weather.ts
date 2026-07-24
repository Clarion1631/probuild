import { unstable_cache } from "next/cache";

export interface VancouverForecastDay {
    date: string;
    high: number;
    low: number;
    precipitationProbability: number;
    weatherCode: number;
    glyph: string;
}

interface OpenMeteoDailyForecast {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
}

interface OpenMeteoForecastResponse {
    daily: OpenMeteoDailyForecast;
}

const VANCOUVER_FORECAST_URL = "https://api.open-meteo.com/v1/forecast?latitude=45.6617&longitude=-122.5484&daily=weather_code%2Ctemperature_2m_max%2Ctemperature_2m_min%2Cprecipitation_probability_max&temperature_unit=fahrenheit&timezone=America%2FLos_Angeles&forecast_days=10";

export function weatherCodeToGlyph(code: number): string {
    if (code === 0) return "\u2600\uFE0F";
    if (code === 1 || code === 2) return "\u{1F324}\uFE0F";
    if (code === 3) return "\u2601\uFE0F";
    if (code === 45 || code === 48) return "\u{1F32B}\uFE0F";
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "\u{1F327}\uFE0F";
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "\u{1F328}\uFE0F";
    if (code >= 95 && code <= 99) return "\u26C8\uFE0F";
    return "\u2601\uFE0F";
}

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item));
}

function parseForecast(value: unknown): VancouverForecastDay[] | null {
    if (!value || typeof value !== "object" || !("daily" in value)) return null;
    const daily = (value as OpenMeteoForecastResponse).daily;
    if (!daily || !Array.isArray(daily.time) || !daily.time.every(item => typeof item === "string")) return null;
    if (!isNumberArray(daily.weather_code)
        || !isNumberArray(daily.temperature_2m_max)
        || !isNumberArray(daily.temperature_2m_min)
        || !isNumberArray(daily.precipitation_probability_max)) return null;

    const dayCount = Math.min(
        10,
        daily.time.length,
        daily.weather_code.length,
        daily.temperature_2m_max.length,
        daily.temperature_2m_min.length,
        daily.precipitation_probability_max.length,
    );
    return Array.from({ length: dayCount }, (_, index) => ({
        date: daily.time[index],
        high: Math.round(daily.temperature_2m_max[index]),
        low: Math.round(daily.temperature_2m_min[index]),
        precipitationProbability: Math.round(daily.precipitation_probability_max[index]),
        weatherCode: daily.weather_code[index],
        glyph: weatherCodeToGlyph(daily.weather_code[index]),
    }));
}

async function fetchVancouverWeather(): Promise<VancouverForecastDay[] | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3_000);
    try {
        const response = await fetch(VANCOUVER_FORECAST_URL, {
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) return null;
        return parseForecast(await response.json());
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

const getCachedVancouverWeather = unstable_cache(
    fetchVancouverWeather,
    ["vancouver-wa-weather"],
    { revalidate: 3_600 },
);

export async function getVancouverWeather(): Promise<VancouverForecastDay[] | null> {
    try {
        return await getCachedVancouverWeather();
    } catch {
        return null;
    }
}
