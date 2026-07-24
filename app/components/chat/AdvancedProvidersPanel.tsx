import React, { useMemo, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { ADVANCED_PROVIDERS, NIMBUS_ONLY_MODE } from '~/utils/constants';
import type { ProviderInfo } from '~/types/model';
import { APIKeyManager } from './APIKeyManager';

interface AdvancedProvidersPanelProps {
  /** Currently entered per-provider API keys (from the parent Chat state). */
  apiKeys: Record<string, string>;
  onApiKeysChange: (providerName: string, apiKey: string) => void;

  /**
   * Optional: when the user picks a BYOK provider we can hand the parent a
   * "please switch the primary picker to this provider now" callback. The
   * parent (Chat.client.tsx) already knows how to swap providers, so we just
   * expose the button and let the parent decide the flow.
   */
  onSelectProvider?: (provider: ProviderInfo) => void;
}

/**
 * "Advanced — bring your own key" collapsible panel.
 *
 * Renders only when the deployment ships as NIMBUS_ONLY (customer-facing
 * Nimbus). Provides a card per non-Nimbus provider with an inline
 * APIKeyManager so power users can plug their own upstream API key without
 * ever seeing the upstream vendor list in the primary picker.
 *
 * When NIMBUS_ONLY is off (self-host, dev) the panel returns null so the
 * upstream provider picker in ModelSelector is the single source of truth.
 */
export const AdvancedProvidersPanel: React.FC<AdvancedProvidersPanelProps> = ({
  apiKeys,
  onApiKeysChange,
  onSelectProvider,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [openProvider, setOpenProvider] = useState<string | null>(null);

  const providers = useMemo(() => ADVANCED_PROVIDERS as unknown as ProviderInfo[], []);

  if (!NIMBUS_ONLY_MODE || providers.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 border-t border-bolt-elements-borderColor pt-2">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className={classNames(
          'w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs',
          'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary',
          'transition-colors',
        )}
        aria-expanded={isExpanded}
        aria-controls="nimbus-advanced-providers-list"
      >
        <span className="flex items-center gap-2">
          <span className="i-ph:key" />
          <span>Advanced — bring your own key</span>
          <span className="opacity-60">({providers.length})</span>
        </span>
        <span className={classNames('i-ph:caret-down transition-transform', isExpanded ? 'rotate-180' : '')} />
      </button>

      {isExpanded && (
        <div
          id="nimbus-advanced-providers-list"
          className="mt-2 space-y-1 max-h-[280px] overflow-y-auto pr-1"
        >
          <p className="text-[11px] text-bolt-elements-textTertiary px-2 pb-1 leading-relaxed">
            Route requests through your own upstream key instead of the Nimbus catalog. Keys stay in your browser
            (scoped to <code>.nimbusapi.net</code>) and never touch the Nimbus billing pipeline.
          </p>
          {providers.map((provider) => {
            const isOpen = openProvider === provider.name;
            const hasKey = !!apiKeys[provider.name];

            return (
              <div
                key={provider.name}
                className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1"
              >
                <button
                  type="button"
                  onClick={() => setOpenProvider(isOpen ? null : provider.name)}
                  className={classNames(
                    'w-full flex items-center justify-between px-3 py-2 text-xs',
                    'text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2',
                    'transition-colors rounded-md',
                  )}
                  aria-expanded={isOpen}
                >
                  <span className="flex items-center gap-2">
                    <span className={classNames(provider.icon || 'i-ph:plug', 'w-3.5 h-3.5 opacity-70')} />
                    <span className="font-medium">{provider.name}</span>
                    {hasKey && (
                      <span className="text-[10px] text-green-500 flex items-center gap-1">
                        <span className="i-ph:check-circle-fill w-3 h-3" />
                        key saved
                      </span>
                    )}
                  </span>
                  <span className={classNames('i-ph:caret-down transition-transform', isOpen ? 'rotate-180' : '')} />
                </button>

                {isOpen && (
                  <div className="px-3 pb-3 pt-1 border-t border-bolt-elements-borderColor">
                    <APIKeyManager
                      provider={provider}
                      apiKey={apiKeys[provider.name] || ''}
                      setApiKey={(key) => onApiKeysChange(provider.name, key)}
                    />
                    {hasKey && onSelectProvider && (
                      <button
                        type="button"
                        onClick={() => onSelectProvider(provider)}
                        className={classNames(
                          'mt-1 text-[11px] px-2 py-1 rounded',
                          'bg-purple-500/10 hover:bg-purple-500/20',
                          'text-purple-400 transition-colors',
                        )}
                      >
                        Use {provider.name} for the next message
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
