import Stripe from "stripe";

// We use a dummy key fallback during Next.js static build resolution 
// to prevent Vercel from crashing if the secret isn't loaded in the CI pipeline.
const stripeKey = process.env.STRIPE_SECRET_KEY || "sk_test_placeholder";

export const stripe = new Stripe(stripeKey, {
    // Note: Cast to any to avoid TS errors across different Stripe package versions
    apiVersion: "2024-12-18.acacia" as any, 
    appInfo: {
        name: "ProBuild",
        version: "0.1.0",
    },
});
