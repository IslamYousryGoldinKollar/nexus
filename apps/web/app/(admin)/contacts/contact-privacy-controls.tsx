'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

interface ContactPrivacyControlsProps {
  contactId: string;
  field: 'allowTranscription' | 'allowAction';
  defaultValue: boolean;
}

export default function ContactPrivacyControls({
  contactId,
  field,
  defaultValue,
}: ContactPrivacyControlsProps) {
  const [value, setValue] = useState(defaultValue);
  const [loading, setLoading] = useState(false);

  const handleChange = async (newValue: boolean) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/contacts/${contactId}/privacy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: newValue }),
      });
      if (!response.ok) throw new Error('Failed to update');
      setValue(newValue);
    } catch (err) {
      console.error('Failed to update privacy setting:', err);
      setValue(value); // Revert on error
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => handleChange(!value)}
      disabled={loading}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        value ? 'bg-primary' : 'bg-input'
      }`}
      aria-checked={value}
      role="switch"
    >
      {loading && (
        <Loader2 className="absolute left-1 top-1 size-3 animate-spin text-white" />
      )}
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          value ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
