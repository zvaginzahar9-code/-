import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Flip } from 'gsap/Flip';
import Lenis from 'lenis';
import { reducedMotion } from './env';

gsap.registerPlugin(ScrollTrigger, Flip);

export let lenis: Lenis | null = null;

export function initSmooth() {
  if (reducedMotion) return;
  lenis = new Lenis({ lerp: 0.1, smoothWheel: true, anchors: { offset: -60 } });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add(time => lenis?.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

export function lockScroll(on: boolean) {
  if (lenis) on ? lenis.stop() : lenis.start();
  document.documentElement.style.overflow = on ? 'hidden' : '';
}

export function scrollToEl(el: Element | string) {
  if (lenis) lenis.scrollTo(el as HTMLElement, { offset: -60 });
  else (typeof el === 'string' ? document.querySelector(el) : el)?.scrollIntoView({ behavior: 'smooth' });
}

export { gsap, ScrollTrigger, Flip };
