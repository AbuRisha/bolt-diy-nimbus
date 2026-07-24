import { useState, useCallback } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { toast } from 'react-toastify';

const DEPLOY_OPTIONS = [
  {
    id: 'vercel',
    label: 'Vercel',
    icon: '▲',
    color: '#fff',
    description: 'Zero-config frontend deployment, instant HTTPS + CDN.',
    command: 'npx vercel@latest deploy --prod',
    dashboardUrl: 'https://vercel.com/new',
    dashboardLabel: 'Open Vercel',
  },
  {
    id: 'netlify',
    label: 'Netlify',
    icon: '◆',
    color: '#00C7B7',
    description: 'Drag-and-drop or CLI. Generous free tier with form handling.',
    command: 'npx netlify-cli deploy --prod --dir .',
    dashboardUrl: 'https://app.netlify.com/start',
    dashboardLabel: 'Open Netlify',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Pages',
    icon: '⚡',
    color: '#F38020',
    description: 'Global edge network, 500 builds/month free.',
    command: 'npx wrangler@latest pages deploy . --project-name my-app',
    dashboardUrl: 'https://pages.cloudflare.com/',
    dashboardLabel: 'Open Cloudflare',
  },
  {
    id: 'github',
    label: 'GitHub Pages',
    icon: '⬡',
    color: '#aaa',
    description: 'Free static hosting tied to your GitHub repo.',
    command: 'npx gh-pages -d . -b gh-pages',
    dashboardUrl: 'https://pages.github.com/',
    dashboardLabel: 'Open GitHub Pages',
  },
] as const;

export function DeployButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1800);
    });
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="rounded-md items-center justify-center px-3 py-1.5 text-xs bg-violet-600 text-white hover:bg-violet-500 transition-colors flex gap-1.5 ml-1"
      >
        <div className="i-ph:rocket-launch" />
        Deploy
      </button>

      <Transition appear show={isOpen} as={Fragment}>
        <Dialog as="div" className="relative z-[400]" onClose={() => setIsOpen(false)}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-200"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-150"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-200"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-150"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0d0f1a] p-6 shadow-2xl">
                  <div className="mb-5 flex items-start justify-between">
                    <div>
                      <Dialog.Title className="text-base font-semibold text-white">
                        Deploy your app
                      </Dialog.Title>
                      <p className="mt-0.5 text-sm text-white/50">
                        Sync files to your machine first, then pick a platform.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsOpen(false)}
                      className="text-white/40 hover:text-white transition-colors"
                    >
                      <div className="i-ph:x-circle text-xl" />
                    </button>
                  </div>

                  {/* Step 1 — sync */}
                  <div className="mb-4 flex items-center gap-3 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06] px-4 py-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cyan-400/40 text-[11px] font-bold text-cyan-400">
                      1
                    </span>
                    <div className="text-sm text-cyan-200/80">
                      <span className="font-semibold text-cyan-300">Sync your files locally</span>
                      {' '}— use the{' '}
                      <span className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px] text-white">Sync</span>{' '}
                      button in the toolbar to download all generated files to a folder on your machine.
                    </div>
                  </div>

                  {/* Step 2 — pick platform */}
                  <div className="mb-3 flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-violet-400/40 text-[11px] font-bold text-violet-400">
                      2
                    </span>
                    <span className="text-sm font-medium text-white/70">Choose a deployment platform</span>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {DEPLOY_OPTIONS.map((opt) => (
                      <div
                        key={opt.id}
                        className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 hover:border-white/20 transition-colors"
                      >
                        <div className="mb-2 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-base" style={{ color: opt.color }}>{opt.icon}</span>
                            <span className="text-sm font-semibold text-white">{opt.label}</span>
                          </div>
                          <a
                            href={opt.dashboardUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-white/40 hover:text-violet-300 transition-colors font-mono flex items-center gap-0.5"
                          >
                            {opt.dashboardLabel}
                            <div className="i-ph:arrow-square-out text-xs" />
                          </a>
                        </div>
                        <p className="mb-3 text-[11px] text-white/50 leading-relaxed">{opt.description}</p>
                        <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-black/30 px-2.5 py-1.5">
                          <code className="flex-1 truncate font-mono text-[11px] text-emerald-400">
                            {opt.command}
                          </code>
                          <button
                            type="button"
                            onClick={() => copy(opt.command, opt.id)}
                            className="shrink-0 text-white/40 hover:text-white transition-colors"
                            title="Copy command"
                          >
                            {copied === opt.id ? (
                              <div className="i-ph:check text-emerald-400" />
                            ) : (
                              <div className="i-ph:copy" />
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <p className="mt-4 text-[11px] text-white/30">
                    Run the command above from the folder where you synced your files.
                    Each platform’s CLI will guide you through authentication + deploy.
                  </p>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>
    </>
  );
}
