export function extractProsCons(html){

const pros =
html.match(
/<h2[^>]*>Pros<\/h2>([\s\S]*?)<\/ul>/
);

const cons =
html.match(
/<h2[^>]*>Cons<\/h2>([\s\S]*?)<\/ul>/
);


return {
pros:pros ? pros[1] : [],
cons:cons ? cons[1] : []
};

}
