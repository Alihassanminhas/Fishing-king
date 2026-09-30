import { useState, type FormEvent } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

export default function StripeCheckout({ clientSecret, orderId }: { clientSecret: string; orderId: string }) {
  return <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe', variables: { colorPrimary: '#0c4a6e', borderRadius: '8px' } } }}>
    <PaymentForm orderId={orderId}/>
  </Elements>;
}

function PaymentForm({ orderId }: { orderId: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function pay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError('');
    try {
      const result = await stripe.confirmPayment({ elements, confirmParams: { return_url: `${window.location.origin}/orders` } });
      if (result.error) setError(result.error.message ?? 'Payment could not be confirmed.');
    } catch {
      setError('Payment could not be confirmed. Please try again.');
    } finally { setBusy(false); }
  }

  return <form onSubmit={event => void pay(event)} className="mt-8 max-w-xl space-y-5 rounded-2xl border bg-white p-6">
    <p className="text-sm text-slate-600">Order reference <span className="font-mono">{orderId.slice(0, 8)}</span></p>
    <PaymentElement/>
    <button className="button button-primary w-full" disabled={!stripe || busy}>{busy ? 'Confirming…' : 'Pay securely'}</button>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <p className="text-xs text-slate-500">Secure payment processed by Stripe. Card details never touch our server.</p>
  </form>;
}
