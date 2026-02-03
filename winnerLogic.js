const Hand = require('pokersolver').Hand;

function determineWinner(communityCards, players) {
    // Only include players who haven't folded
    const activePlayers = players.filter(p => !p.folded);

    const hands = activePlayers.map(player => {
        // Combine community cards + player's 2 cards
        const fullHand = [...communityCards, ...player.cards];
        const solvedHand = Hand.solve(fullHand);
        solvedHand.playerId = player.id; // Keep track of who owns this hand
        return solvedHand;
    });

    const winners = Hand.winners(hands);
    
    // Return the ID of the winner(s) and the hand name (e.g., "Full House")
    return winners.map(w => ({
        id: w.playerId,
        descr: w.descr
    }));
}