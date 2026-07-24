import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { chatStore } from '~/lib/stores/chat';
import { classNames } from '~/utils/classNames';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';

const NIMBUS_LINKS = [
  { label: 'Home', href: 'https://nimbusapi.net' },
  { label: 'Chat', href: 'https://chat.nimbusapi.net' },
  { label: 'Builder', href: 'https://builder.nimbusapi.net', active: true },
  { label: 'Image', href: 'https://nimbusapi.net/dashboard/image' },
  { label: 'Video', href: 'https://nimbusapi.net/dashboard/video' },
  { label: 'Docs', href: 'https://nimbusapi.net/docs' },
];

export function Header() {
  const chat = useStore(chatStore);

  return (
    <header
      className={classNames('flex items-center px-4 border-b h-[var(--header-height)]', {
        'border-transparent': !chat.started,
        'border-bolt-elements-borderColor': chat.started,
      })}
    >
      <div className="flex items-center gap-2 z-logo text-bolt-elements-textPrimary cursor-pointer">
        <div className="i-ph:sidebar-simple-duotone text-xl" />
        <a
          href="/"
          className="flex items-center gap-2 group"
          aria-label="Nimbus Builder"
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="shrink-0 transition-transform group-hover:scale-105"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="nimbus-mark" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#8B5CF6" />
                <stop offset="1" stopColor="#22D3EE" />
              </linearGradient>
            </defs>
            {/* Cloud silhouette */}
            <path
              d="M9 22h14a5 5 0 0 0 .8-9.94 7 7 0 0 0-13.5-1.31A5 5 0 0 0 9 22z"
              fill="url(#nimbus-mark)"
              fillOpacity="0.18"
              stroke="url(#nimbus-mark)"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            {/* Bolt */}
            <path
              d="M17.4 10.2l-4.8 7.4h3.1l-1.1 5.4 5.2-7.6h-3.2l0.8-5.2z"
              fill="url(#nimbus-mark)"
              stroke="#05070E"
              strokeWidth="0.4"
              strokeLinejoin="round"
            />
          </svg>
          <span
            className="text-[1.35rem] leading-none font-semibold tracking-tight"
            style={{
              fontFamily: '"Space Grotesk", Inter, ui-sans-serif, system-ui, sans-serif',
              backgroundImage: 'linear-gradient(90deg, #8B5CF6 0%, #22D3EE 100%)',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              color: 'transparent',
              WebkitTextFillColor: 'transparent',
            }}
          >
            Nimbus&nbsp;Builder
          </span>
        </a>
      </div>
      <nav className="hidden md:flex items-center gap-4 ml-6 text-xs text-bolt-elements-textSecondary">
        {NIMBUS_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className={classNames(
              'hover:text-bolt-elements-textPrimary transition-colors',
              link.active ? 'text-bolt-elements-textPrimary font-semibold' : '',
            )}
          >
            {link.label}
          </a>
        ))}
      </nav>
      {chat.started && ( // Display ChatDescription and HeaderActionButtons only when the chat has started.
        <>
          <span className="flex-1 px-4 truncate text-center text-bolt-elements-textPrimary">
            <ClientOnly>{() => <ChatDescription />}</ClientOnly>
          </span>
          <ClientOnly>
            {() => (
              <div className="">
                <HeaderActionButtons chatStarted={chat.started} />
              </div>
            )}
          </ClientOnly>
        </>
      )}
    </header>
  );
}
