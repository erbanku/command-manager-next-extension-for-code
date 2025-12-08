import { Timer, SubTimer, TimerFolder } from '../../../src/types';

/**
 * Helper utilities for Timer operations.
 * Centralizes duplicated logic found throughout TimeTrackerManager, TimeTrackerTreeItem, and TimeTrackerStatusBar.
 */
export class TimerHelpers {
	/**
	 * Pauses a single subtimer and accumulates elapsed time.
	 *
	 * Previously duplicated at:
	 * - TimeTrackerManager.ts lines 292-306, 329-343, 448-462, 611-626, 666-677, 1171-1184, 1219-1233
	 *
	 * @param subtimer The subtimer to pause
	 * @param now Optional pause time (defaults to current time)
	 */
	static pauseSubtimer(subtimer: SubTimer, now?: Date): void {
		if (subtimer.endTime) {
			return; // Already paused
		}

		const pauseTime = now || new Date();
		const lastResumeTime = subtimer.lastResumeTime
			? new Date(subtimer.lastResumeTime)
			: new Date(subtimer.startTime);
		const elapsedThisSegment = pauseTime.getTime() - lastResumeTime.getTime();

		if (subtimer.totalElapsedTime === undefined) {
			subtimer.totalElapsedTime = elapsedThisSegment;
		} else {
			subtimer.totalElapsedTime += elapsedThisSegment;
		}

		subtimer.endTime = pauseTime.toISOString();
	}

	/**
	 * Finds a timer by ID across all folders in the hierarchy.
	 *
	 * Previously duplicated at:
	 * - TimeTrackerManager.ts lines 367-379, 586-598, 644-656, 743-755, 817-829
	 *
	 * @param folders The folder hierarchy to search
	 * @param timerId The timer ID to find
	 * @returns The timer if found, undefined otherwise
	 */
	static findTimer(folders: TimerFolder[], timerId: string): Timer | undefined {
		for (const folder of folders) {
			const timer = folder.timers.find(t => t.id === timerId);
			if (timer) {
				return timer;
			}
			if (folder.subfolders) {
				const found = TimerHelpers.findTimer(folder.subfolders, timerId);
				if (found) {
					return found;
				}
			}
		}
		return undefined;
	}

	/**
	 * Finds a timer by a custom predicate across all folders.
	 *
	 * @param folders The folder hierarchy to search
	 * @param predicate Function to test each timer
	 * @returns The timer if found, undefined otherwise
	 */
	static findTimerBy(
		folders: TimerFolder[],
		predicate: (timer: Timer) => boolean
	): Timer | undefined {
		for (const folder of folders) {
			const timer = folder.timers.find(predicate);
			if (timer) {
				return timer;
			}
			if (folder.subfolders) {
				const found = TimerHelpers.findTimerBy(folder.subfolders, predicate);
				if (found) {
					return found;
				}
			}
		}
		return undefined;
	}

	/**
	 * Iterates over all timers in the folder hierarchy.
	 *
	 * Previously duplicated at:
	 * - TimeTrackerManager.ts lines 186-199, 320-357, 603-639, 915-949, 988-1003
	 *
	 * @param folders The folder hierarchy to traverse
	 * @param callback Function called for each timer. Return true to stop iteration.
	 */
	static forEachTimer(
		folders: TimerFolder[],
		callback: (timer: Timer, folder: TimerFolder) => void | boolean
	): void {
		for (const folder of folders) {
			for (const timer of folder.timers) {
				const shouldStop = callback(timer, folder);
				if (shouldStop === true) {
					return;
				}
			}
			if (folder.subfolders) {
				TimerHelpers.forEachTimer(folder.subfolders, callback);
			}
		}
	}

	/**
	 * Calculates current elapsed time for a subtimer, handling pause/resume correctly.
	 *
	 * Previously duplicated at:
	 * - TimeTrackerManager.ts lines 52-66
	 * - TimeTrackerTreeItem.ts lines 202-231
	 * - TimeTrackerStatusBar.ts lines 88-101 (BUGGY - didn't account for pauses)
	 *
	 * @param subtimer The subtimer to calculate elapsed time for
	 * @param nowMs Current time in milliseconds (for consistency across calculations)
	 * @returns Elapsed time in milliseconds
	 */
	static calculateSubtimerElapsed(subtimer: SubTimer, nowMs: number): number {
		const baseElapsed = subtimer.totalElapsedTime ?? 0;

		if (subtimer.endTime) {
			// Paused - return accumulated time only
			return baseElapsed;
		}

		// Running - add current segment to accumulated time
		const resumeTime = subtimer.lastResumeTime
			? new Date(subtimer.lastResumeTime).getTime()
			: new Date(subtimer.startTime).getTime();

		if (!Number.isFinite(resumeTime)) {
			return baseElapsed;
		}

		const delta = nowMs - resumeTime;
		return delta > 0 ? baseElapsed + delta : baseElapsed;
	}

	/**
	 * Calculates total elapsed time for all subtimers in a timer.
	 *
	 * @param timer The timer containing subtimers
	 * @param nowMs Current time in milliseconds
	 * @returns Total elapsed time in milliseconds
	 */
	static calculateTimerElapsed(timer: Timer, nowMs: number): number {
		if (!timer.subtimers || timer.subtimers.length === 0) {
			return 0;
		}

		let totalMs = 0;
		for (const subtimer of timer.subtimers) {
			totalMs += TimerHelpers.calculateSubtimerElapsed(subtimer, nowMs);
		}

		return totalMs;
	}

	/**
	 * Formats elapsed time in milliseconds to human-readable string.
	 *
	 * Previously duplicated at:
	 * - TimeTrackerManager.ts lines 128-144
	 * - TimeTrackerTreeItem.ts lines 124-136
	 * - TimeTrackerStatusBar.ts lines 103-115
	 *
	 * @param ms Elapsed time in milliseconds
	 * @returns Formatted string like "1h 23m 45s", "23m 45s", or "45s"
	 */
	static formatElapsedTime(ms: number): string {
		const totalSeconds = Math.max(0, Math.floor(ms / 1000));
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;

		if (hours > 0) {
			return `${hours}h ${minutes}m ${seconds}s`;
		} else if (minutes > 0) {
			return `${minutes}m ${seconds}s`;
		} else {
			return `${seconds}s`;
		}
	}

	/**
	 * Gets all timers from folder hierarchy as a flat array.
	 *
	 * @param folders The folder hierarchy
	 * @param includeArchived Whether to include archived timers
	 * @returns Array of all timers
	 */
	static getAllTimers(folders: TimerFolder[], includeArchived: boolean = true): Timer[] {
		const timers: Timer[] = [];
		TimerHelpers.forEachTimer(folders, (timer) => {
			if (includeArchived || !timer.archived) {
				timers.push(timer);
			}
		});
		return timers;
	}

	/**
	 * Gets all running timers (timers with at least one running subtimer).
	 *
	 * @param folders The folder hierarchy
	 * @returns Array of running timers
	 */
	static getRunningTimers(folders: TimerFolder[]): Timer[] {
		const runningTimers: Timer[] = [];
		TimerHelpers.forEachTimer(folders, (timer) => {
			if (timer.subtimers?.some(st => !st.endTime)) {
				runningTimers.push(timer);
			}
		});
		return runningTimers;
	}

	/**
	 * Checks if a timer has any running subtimers.
	 *
	 * @param timer The timer to check
	 * @returns True if any subtimer is running
	 */
	static isTimerRunning(timer: Timer): boolean {
		return timer.subtimers?.some(st => !st.endTime) ?? false;
	}

	/**
	 * Collects timers matching a predicate from folder hierarchy.
	 *
	 * @param folders The folder hierarchy
	 * @param predicate Function to test each timer
	 * @returns Array of matching timers
	 */
	static collectTimers(
		folders: TimerFolder[],
		predicate: (timer: Timer) => boolean
	): Timer[] {
		const results: Timer[] = [];
		TimerHelpers.forEachTimer(folders, (timer) => {
			if (predicate(timer)) {
				results.push(timer);
			}
		});
		return results;
	}
}
