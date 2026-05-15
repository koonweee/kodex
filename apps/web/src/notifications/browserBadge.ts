type BadgeNavigator = Navigator & {
  clearAppBadge?: () => Promise<void>;
  setAppBadge?: (contents?: number) => Promise<void>;
};

export async function setKodexAppBadge(count: number): Promise<boolean> {
  const badgeNavigator = globalThis.navigator as BadgeNavigator | undefined;
  if (!badgeNavigator?.setAppBadge || !badgeNavigator.clearAppBadge) {
    return false;
  }
  try {
    if (count > 0) {
      await badgeNavigator.setAppBadge(count);
    } else {
      await badgeNavigator.clearAppBadge();
    }
    return true;
  } catch {
    return false;
  }
}
