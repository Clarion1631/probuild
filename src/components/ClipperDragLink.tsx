"use client";

// React 19 blocks `javascript:` URLs passed through the `href` prop —
// renderToStaticMarkup emits a booby-trapped href that throws instead of the
// real bookmarklet code (see https://react.dev/blog/2024/04/25/react-19#new-feature-support-for-metadata-tags
// / the "blocked a javascript: URL" security precaution). The ProBuild Clip
// bookmarklet legitimately needs a javascript: href, so we set it on the DOM
// node directly in an effect, bypassing React's href sanitizer entirely.
import { useEffect, useRef, type ReactNode } from "react";

export default function ClipperDragLink({
    href,
    className,
    title,
    children,
}: {
    href: string;
    className?: string;
    title?: string;
    children: ReactNode;
}) {
    const ref = useRef<HTMLAnchorElement>(null);

    useEffect(() => {
        ref.current?.setAttribute("href", href);
    }, [href]);

    return (
        <a
            ref={ref}
            href="#"
            onClick={(e) => e.preventDefault()}
            className={className}
            title={title}
            aria-label={title}
        >
            {children}
        </a>
    );
}
