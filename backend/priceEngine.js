import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import { readJSON, writeJSON, logError, logTelemetry, DATA_DIR } from './db.js';

const RATES_FILE = path.join(DATA_DIR, 'rates.json');

// Initialize rates.json if not present
const defaultRates = {
    lastUpdated: new Date().toISOString(),
    status: "default",
    price24K: 7500.0,  // default fallback rate per gram (INR)
    price22K: 6875.0,  // 22/24 of 24K
    price18K: 5625.0   // 18/24 of 24K
};
readJSON(RATES_FILE, defaultRates);

/**
 * Fetches gold price from external API and updates rates.json.
 *
 * Two providers only, both keyless: 'public' (Yahoo Finance gold futures) and
 * 'mock' (a small synthetic drift, for testing). The paid GoldAPI.io and
 * Metals.dev integrations were removed in 1.2.0 along with the API-key field;
 * any legacy provider value in a tenant's settings is normalized to 'public'
 * by migrateSettings() and treated as 'public' here regardless.
 */
export async function syncGoldPrice() {
    const startTime = Date.now();
    const settings = readJSON(path.join(DATA_DIR, 'settings.json'), {});
    const provider = settings.goldApiProvider === 'mock' ? 'mock' : 'public';

    logTelemetry('PRICE_SYNC_START', 0, `Provider: ${provider}`);

    try {
        let goldPriceUSDPerOunce = 2350.0; // Base default troy ounce price if fetch fails
        let exchangeRateUSDToLocal = 83.50; // Base default exchange rate (USD to INR)

        // 1. Fetch USD to Local Exchange Rate
        try {
            const exRes = await fetch('https://open.er-api.com/v6/latest/USD');
            if (exRes.ok) {
                const exData = await exRes.json();
                const targetCurrency = settings.currency || 'INR';
                if (exData.rates && exData.rates[targetCurrency]) {
                    exchangeRateUSDToLocal = exData.rates[targetCurrency];
                }
            }
        } catch (exErr) {
            logError('Exchange rate sync failed, using default currency conversion rate: ' + exErr.message);
        }

        // 2. Fetch Gold Price (Troy Ounce XAU)
        if (provider === 'public') {
            // Yahoo Finance keyless Gold Futures Ticker (GC=F)
            const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F');
            if (response.ok) {
                const data = await response.json();
                if (data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta) {
                    goldPriceUSDPerOunce = data.chart.result[0].meta.regularMarketPrice;
                }
            } else {
                throw new Error(`Yahoo Finance API returned status: ${response.status}`);
            }
        } else {
            // Mock provider -> Generate a slight daily float to simulate auto-updating
            const variance = (Math.random() - 0.5) * 15.0; // +/- $7.50 troy ounce
            goldPriceUSDPerOunce = 2350.0 + variance;
            logTelemetry('PRICE_SYNC_MOCK', 0, 'Mock gold price pulled.');
        }

        // Calculate gold rate per gram (1 Troy Ounce = 31.1034768 Grams)
        const pricePerGram24K = (goldPriceUSDPerOunce / 31.1034768) * exchangeRateUSDToLocal;
        const rounded24K = Math.round(pricePerGram24K * 100) / 100;
        const rounded22K = Math.round((rounded24K * 22 / 24) * 100) / 100;
        const rounded18K = Math.round((rounded24K * 18 / 24) * 100) / 100;

        const updatedRates = {
            lastUpdated: new Date().toISOString(),
            status: provider === 'mock' ? 'mocked' : 'synced',
            price24K: rounded24K,
            price22K: rounded22K,
            price18K: rounded18K
        };

        writeJSON(RATES_FILE, updatedRates);
        logTelemetry('PRICE_SYNC_SUCCESS', Date.now() - startTime, `24K: ${rounded24K}, 22K: ${rounded22K}`);
        return updatedRates;

    } catch (err) {
        logError('Gold pricing sync exception: ' + err.message, err.stack);
        logTelemetry('PRICE_SYNC_FAIL', Date.now() - startTime, err.message);
        
        // Return existing rates to maintain operational stability
        return readJSON(RATES_FILE, defaultRates);
    }
}

/**
 * Returns current active gold rates.
 * Checks and prioritizes manual overrides for 24K, 22K, and 18K individually.
 */
export function getActiveGoldRates() {
    const settings = readJSON(path.join(DATA_DIR, 'settings.json'), {});
    const rates = readJSON(RATES_FILE, defaultRates);
    const override = settings.overrideGoldPrice || {};

    const active24K = (parseFloat(override.price24K) > 0) ? parseFloat(override.price24K) : rates.price24K;
    const active22K = (parseFloat(override.price22K) > 0) ? parseFloat(override.price22K) : rates.price22K;
    const active18K = (parseFloat(override.price18K) > 0) ? parseFloat(override.price18K) : rates.price18K;

    const hasOverride = (override.price24K > 0 || override.price22K > 0 || override.price18K > 0);

    return {
        source: hasOverride ? 'manual' : 'auto',
        lastUpdated: rates.lastUpdated,
        price24K: active24K,
        price22K: active22K,
        price18K: active18K,
        raw: {
            price24K: rates.price24K,
            price22K: rates.price22K,
            price18K: rates.price18K
        },
        sources: {
            price24K: (override.price24K > 0) ? 'manual' : 'auto',
            price22K: (override.price22K > 0) ? 'manual' : 'auto',
            price18K: (override.price18K > 0) ? 'manual' : 'auto'
        }
    };
}

/**
 * Setup Cron Scheduler
 * Cron Pattern: '0 0 * * *' executes at 12:00 AM every midnight.
 */
export function initPriceScheduler() {
    cron.schedule('0 0 * * *', async () => {
        console.log('[Scheduler] Executing daily midnight gold price sync...');
        await syncGoldPrice();
    });
    console.log('[Scheduler] Daily midnight Gold Price Sync initialized.');
}
