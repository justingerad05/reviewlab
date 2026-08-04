export function calculateScore(score){

const values = Object.values(score);

return Math.round(
values.reduce((a,b)=>a+b,0)
/
values.length
);

}
