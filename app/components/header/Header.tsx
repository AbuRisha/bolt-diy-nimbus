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
        <a href="/" className="text-2xl font-semibold text-accent flex items-center">
          {/* <span className="i-bolt:logo-text?mask w-[46px] inline-block" /> */}
          <img src="/logo-light-styled.png" alt="logo" className="w-[90px] inline-block dark:hidden" />
          <img src="/logo-dark-styled.png" alt="logo" className="w-[90px] inline-block hidden dark:block" />
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
