export const PLAYER_SYNC_SCRIPT = `
(function () {
    const players = Array.from(document.querySelectorAll('video, audio'));
    if (players.length !== 2) {
        return;
    }
    const DRIFT_SECONDS = 0.25;
    const SEEK_MATCH_SECONDS = 0.05;
    const expectedSeek = new Map();
    let leader = players[0];

    function otherOf(player) {
        return player === players[0] ? players[1] : players[0];
    }

    function endOf(player) {
        return Number.isFinite(player.duration) ? player.duration : Infinity;
    }

    function hasTimeLeft(player, time) {
        return time < endOf(player);
    }

    function seekQuietly(player, time) {
        const target = Math.min(time, endOf(player));
        expectedSeek.set(player, target);
        player.currentTime = target;
    }

    function isOwnSeek(player) {
        const target = expectedSeek.get(player);
        if (target === undefined) {
            return false;
        }
        expectedSeek.delete(player);
        return Math.abs(player.currentTime - target) < SEEK_MATCH_SECONDS;
    }

    for (const player of players) {
        player.addEventListener('play', () => {
            const other = otherOf(player);
            if (!other.paused) {
                return;
            }
            leader = player;
            if (hasTimeLeft(other, player.currentTime)) {
                seekQuietly(other, player.currentTime);
                other.play();
            }
        });
        player.addEventListener('pause', () => {
            const other = otherOf(player);
            if (player.ended || other.paused) {
                return;
            }
            leader = player;
            other.pause();
        });
        player.addEventListener('seeked', () => {
            if (isOwnSeek(player)) {
                return;
            }
            leader = player;
            const other = otherOf(player);
            seekQuietly(other, player.currentTime);
            if (!player.paused && other.paused && hasTimeLeft(other, player.currentTime)) {
                other.play();
            }
        });
        player.addEventListener('ratechange', () => {
            const other = otherOf(player);
            if (other.playbackRate !== player.playbackRate) {
                other.playbackRate = player.playbackRate;
            }
        });
        player.addEventListener('timeupdate', () => {
            const other = otherOf(player);
            if (player !== leader || player.paused || other.paused || other.seeking) {
                return;
            }
            if (Math.abs(other.currentTime - player.currentTime) > DRIFT_SECONDS) {
                seekQuietly(other, player.currentTime);
            }
        });
    }
})();
`;
