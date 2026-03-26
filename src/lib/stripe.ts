import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("Missing STRIPE_SECRET_KEY environment variable");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    // Note: Cast to any to avoid TS errors across different Stripe package versions
    apiVersion: "2024-12-18.acacia" as any, 
    appInfo: {
        name: "ProBuild",
        version: "0.1.0",
    },
});
