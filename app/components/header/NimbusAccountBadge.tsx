import { useRouteLoaderData } from '@remix-run/react';

/**
 * Signed-in account, balance, and what BUILDER has cost.
 *
 * Spend is scoped to the Builder key rather than the account, so it moves by
 * the cost of a Builder request and by nothing else — that is what makes it
 * usable as a check that billing works. An account-wide total would mix in chat
 * and direct API traffic and answer nothing.
 *
 * "Unavailable" is kept strictly apart from "$0.00". `configured: false` means
 * the server could not reach nimbusapi.net or has no shared secret; rendering
 * that as a zero balance would tell someone with money that they have none.
 */
type NimbusAccount = {
  configured: boolean;
  email?: string;
  balanceUsd?: number;
  builder: {
    hasKey: boolean;
    spendCapUsd: number | null;
    spentUsd: number;
    requestCount: number;
  };
};

const usd = (n: number) =>
  `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    /*
     * Builder requests cost fractions of a cent. Rounding everything to 2dp
     * would render real spend as "$0.00", which is indistinguishable from not
     * being billed at all — the exact doubt this is meant to remove.
     */
    maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2,
  })}`;

export function NimbusAccountBadge() {
  const data = useRouteLoaderData<{ nimbusAccount?: NimbusAccount }>('routes/_index');
  const account = data?.nimbusAccount;

  if (!account?.configured) {
    return null;
  }

  const balance = account.balanceUsd ?? 0;

  return (
    <div
      className="hidden lg:flex items-center gap-3 ml-auto mr-3 text-xs text-bolt-elements-textSecondary"
      title={account.email ? `Signed in as ${account.email}` : undefined}
    >
      {account.email ? (
        <span className="max-w-[180px] truncate text-bolt-elements-textPrimary">{account.email}</span>
      ) : null}
      <span className="flex items-center gap-1">
        <span>Balance</span>
        <span className={balance > 0 ? 'text-emerald-400' : 'text-amber-400'}>{usd(balance)}</span>
      </span>
      <span className="flex items-center gap-1">
        <span>Builder</span>
        <span className="text-bolt-elements-textPrimary">
          {usd(account.builder.spentUsd)}
          {account.builder.requestCount > 0 ? (
            <span className="ml-1 opacity-60">({account.builder.requestCount})</span>
          ) : null}
        </span>
      </span>
      {account.builder.spendCapUsd !== null ? (
        <span className="opacity-70">limit {usd(account.builder.spendCapUsd)}</span>
      ) : null}
    </div>
  );
}
